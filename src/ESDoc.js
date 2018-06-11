import fs from 'fs-extra';
import path from 'path';
import assert from 'assert';
import ASTUtil from './Util/ASTUtil.js';
import ESParser from './Parser/ESParser';
import PathResolver from './Util/PathResolver.js';
import DocFactory from './Factory/DocFactory.js';
import InvalidCodeLogger from './Util/InvalidCodeLogger.js';
import Plugin from './Plugin/Plugin.js';
import {Transform} from 'stream';
import json from 'big-json';
import mkdirp from 'mkdirp';
import log from 'npmlog';

/**
 * API Documentation Generator.
 *
 * @example
 * let config = {source: './src', destination: './esdoc2'};
 * esdoc2.generate(config, (results, config)=>{
 *   console.log(results);
 * });
 */
export default class ESDoc {
  /**
   * Generate documentation.
   * @param {ESDocConfig} config - config for generation.
   */
  static generate(config) {
    return new Promise((resolve) => {
      assert(config.root || config.source);
      if (config.root) {
        assert(!config.source);
        assert(!config.package);
      }
      assert(config.destination);

      this._checkOldConfig(config);

      Plugin.init(config.plugins);
      Plugin.onStart();
      config = Plugin.onHandleConfig(config);

      this._setDefaultConfig(config);

      const includes = config.includes.map((v) => new RegExp(v));
      const excludes = config.excludes.map((v) => new RegExp(v));

      let packageName = null;
      let mainFilePath = null;
      if (config.package) {
        try {
          const packageJSON = fs.readFileSync(config.package, {encode: 'utf8'});
          const packageConfig = JSON.parse(packageJSON);
          packageName = packageConfig.name;
          mainFilePath = packageConfig.main;
        } catch (e) {
        // ignore
        }
      }

      let results = [];
      const sourceDirPath = path.resolve(config.source);
      const onWriteFinish = () => {
        log.info('esdoc2', 'finished generating files');

        // publish
        this._publish(config);

        Plugin.onComplete();

        this._memUsage();
        resolve(true);
      };

      const fatalError = err => {
        log.error(err);
        process.exit(1);
      };

      const stringifyWriteTransform = new Transform({
        writableObjectMode: true,
        readableObjectMode: true,
        transform: function(chunk, encoding, transformCallback) {
          const fullPath = path.resolve(config.destination, `ast/${chunk.filePath}.json`);
          mkdirp(fullPath.split('/').slice(0, -1).join('/'), (err) => {
            if (err) fatalError(err);
            log.verbose('transform', fullPath);
            const fileWriteStream = fs.createWriteStream(fullPath);
            fileWriteStream.on('error', fatalError);
            fileWriteStream.on('finish', () => log.verbose('write', fullPath));
            fileWriteStream.on('finish', transformCallback);

            const stringifyStream = json.createStringifyStream({body: chunk.ast});
            stringifyStream.on('error', fatalError);
            stringifyStream.on('end', fileWriteStream.end);
            stringifyStream.on('end', () => log.verbose('stringified', fullPath));
            stringifyStream.pipe(fileWriteStream);
          });
        }
      });

      stringifyWriteTransform.on('finish', onWriteFinish);
      stringifyWriteTransform.on('error', fatalError);

      const walkCallback = (filePath) => {
        const relativeFilePath = path.relative(sourceDirPath, filePath);

        let match = false;
        for (const reg of includes) {
          if (relativeFilePath.match(reg)) {
            match = true;
            break;
          }
        }
        if (!match) return;

        for (const reg of excludes) {
          if (relativeFilePath.match(reg)) return;
        }

        log.info('parse', filePath);
        const temp = this._traverse(config.source, filePath, packageName, mainFilePath);
        if (!temp) return;
        results.push(...temp.results);
        stringifyWriteTransform.write({filePath: `source${path.sep}${relativeFilePath}`, ast: temp.ast});
      };

      const walkRootCallback = (filePath, fileContents = null) => {
        if (path.basename(filePath) === 'package.json') {
          results.push(this._generateForPackageJSON(filePath, fileContents));
        } else {
          walkCallback(filePath);
        }
      };

      if (config.root) {
        this._walkRoot(config.root, walkRootCallback);
      } else {
        this._walk(config.source, walkCallback);
      }

      stringifyWriteTransform.end();

      // config.index
      if (config.index) {
        results.push(this._generateForIndex(config));
      }

      if (config.package) {
        results.push(this._generateForOldPackageJSON(config));
      }

      results = this._resolveDuplication(results);

      results = Plugin.onHandleDocs(results);

      // index.json
      {
        const dumpPath = path.resolve(config.destination, 'index.json');
        fs.outputFileSync(dumpPath, JSON.stringify(results, null, 2));
      }
    });
  }

  /**
   * check esdoc2 config. and if it is old, exit with warning message.
   * @param {ESDocConfig} config - check config
   * @private
   */
  static _checkOldConfig(config) {
    let exit = false;

    const keys = [
      ['access', 'esdoc2-standard-plugin'],
      ['autoPrivate', 'esdoc2-standard-plugin'],
      ['unexportIdentifier', 'esdoc2-standard-plugin'],
      ['undocumentIdentifier', 'esdoc2-standard-plugin'],
      ['builtinExternal', 'esdoc2-standard-plugin'],
      ['coverage', 'esdoc2-standard-plugin'],
      ['test', 'esdoc2-standard-plugin'],
      ['title', 'esdoc2-standard-plugin'],
      ['manual', 'esdoc2-standard-plugin'],
      ['lint', 'esdoc2-standard-plugin'],
      ['includeSource', 'esdoc2-exclude-source-plugin'],
      ['styles', 'esdoc2-inject-style-plugin'],
      ['scripts', 'esdoc2-inject-script-plugin'],
      ['experimentalProposal', 'esdoc2-ecmascript-proposal-plugin']
    ];

    for (const [key, plugin] of keys) {
      if (key in config) {
        console.error(`[31merror: config.${key} is invalid. Please use ${plugin}. how to migration: https://esdoc2.org/manual/migration.html[0m`);
        exit = true;
      }
    }

    if (exit) process.exit(1);
  }

  /**
   * set default config to specified config.
   * @param {ESDocConfig} config - specified config.
   * @private
   */
  static _setDefaultConfig(config) {
    if (!config.includes) config.includes = ['\\.js$'];

    if (!config.excludes) config.excludes = ['\\.config\\.js$', '\\.test\\.js$'];

    if (!config.index) config.index = './README.md';

    if (config.source && !config.package) config.package = './package.json';
  }


  static _walkRoot(dirPath, callback) {
    const entries = fs.readdirSync(dirPath);

    const hasPackageJson = entries.includes('package.json');

    if (hasPackageJson) {
      const packagePath = path.resolve(dirPath, 'package.json');
      let packageObj;
      try {
        packageObj = require(packagePath);
        console.log('Found package at', packagePath);
      } catch (e) {
        console.error('Failed to parse package at', packagePath);
      }
      if (packageObj) {
        const srcDir = path.resolve(
          dirPath,
          (packageObj.directories && packageObj.directories.src) || 'src'
        );
        // When we encounter a package root, skip to its source dir.
        // Thus we avoid trying to document node_modules and config files.
        let srcDirStat;
        try {
          srcDirStat = fs.statSync(srcDir);
        } catch (e) {
          // handled below
        }
        let error = false;
        if (!srcDirStat) {
          error = true;
          console.error(`Looked for project sources in ${srcDir}, but the directory did not exist.`);
        } else if (!srcDirStat.isDirectory()) {
          error = true;
          console.error(`Tried to find project sources in ${srcDir}, which is not a directory.`);
        }
        if (error) {
          console.error(`You are seeing this because you attempted to document a folder which contains a package.json file.`);
          console.error(`If you need to override a package's source directory, set "directories": { "src": "mySrcDir" } in package.json.`);
        }

        callback(packagePath, packageObj);

        this._walkRoot(srcDir, callback);
        return;
      } else {
        console.error(`Found unparseable package.json at ${packagePath}. Aborting.`);
        return;
      }
    }

    this._walk(dirPath, callback, this._walkRoot);
  }

  /**
   * walk recursive in directory.
   * @param {string} dirPath - target directory path.
   * @param {function(entryPath: string)} callback - callback for find file.
   * @private
   */
  static _walk(dirPath, callback, recurse = this._walk) {
    const entries = fs.readdirSync(dirPath);

    for (const entry of entries) {
      const entryPath = path.resolve(dirPath, entry);
      const stat = fs.statSync(entryPath);

      if (stat.isFile()) {
        callback(entryPath);
      } else if (stat.isDirectory()) {
        recurse(entryPath, callback, recurse);
      }
    }
  }

  /**
   * traverse doc comment in JavaScript file.
   * @param {string} inDirPath - root directory path.
   * @param {string} filePath - target JavaScript file path.
   * @param {string} [packageName] - npm package name of target.
   * @param {string} [mainFilePath] - npm main file path of target.
   * @returns {Object} - return document that is traversed.
   * @property {DocObject[]} results - this is contained JavaScript file.
   * @property {AST} ast - this is AST of JavaScript file.
   * @private
   */
  static _traverse(inDirPath, filePath, packageName, mainFilePath) {
    log.verbose(`parsing: ${filePath}`);
    let ast;
    try {
      ast = ESParser.parse(filePath);
    } catch (e) {
      InvalidCodeLogger.showFile(filePath, e);
      return null;
    }

    const pathResolver = new PathResolver(inDirPath, filePath, packageName, mainFilePath);
    const factory = new DocFactory(ast, pathResolver);

    ASTUtil.traverse(ast, (node, parent) => {
      try {
        factory.push(node, parent);
      } catch (e) {
        InvalidCodeLogger.show(filePath, node);
        throw e;
      }
    });

    return {results: factory.results, ast: ast};
  }

  /**
   * generate index doc
   * @param {ESDocConfig} config
   * @returns {Tag}
   * @private
   */
  static _generateForIndex(config) {
    const indexContent = fs.readFileSync(config.index, {encode: 'utf8'}).toString();
    const tag = {
      kind: 'index',
      content: indexContent,
      longname: path.resolve(config.index),
      name: config.index,
      static: true,
      access: 'public'
    };

    return tag;
  }

  /**
   * generate package doc
   * @param {ESDocConfig} config
   * @returns {Tag}
   * @private
   */
  static _generateForPackageJSON(packagePath, packageObj) {
    return {
      kind: 'package',
      package: packageObj,
      longname: packagePath,
      name: path.basename(packagePath),
      static: true,
      access: 'public'
    };
  }

  static _generateForOldPackageJSON(config) {
    let packageJSON = '';
    let packagePath = '';
    try {
      packageJSON = fs.readFileSync(config.package, {encoding: 'utf-8'});
      packagePath = path.resolve(config.package);
    } catch (e) {
      // ignore
    }

    return Object.assign(this._generateForPackageJSON(packagePath, null), {
      kind: 'packageJSON',
      content: packageJSON,
    });
  }

  /**
   * resolve duplication docs
   * @param {Tag[]} docs
   * @returns {Tag[]}
   * @private
   */
  static _resolveDuplication(docs) {
    const memberDocs = docs.filter((doc) => doc.kind === 'member');
    const removeIds = [];

    for (const memberDoc of memberDocs) {
      // member duplicate with getter/setter/method.
      // when it, remove member.
      // getter/setter/method are high priority.
      const sameLongnameDoc = docs.find((doc) => doc.longname === memberDoc.longname && doc.kind !== 'member');
      if (sameLongnameDoc) {
        removeIds.push(memberDoc.__docId__);
        continue;
      }

      const dup = docs.filter((doc) => doc.longname === memberDoc.longname && doc.kind === 'member');
      if (dup.length > 1) {
        const ids = dup.map(v => v.__docId__);
        ids.sort((a, b) => {
          return a < b ? -1 : 1;
        });
        ids.shift();
        removeIds.push(...ids);
      }
    }

    return docs.filter((doc) => !removeIds.includes(doc.__docId__));
  }

  /**
   * publish content
   * @param {ESDocConfig} config
   * @private
   */
  static _publish(config) {
    try {
      const write = (filePath, content, option) => {
        const _filePath = path.resolve(config.destination, filePath);
        content = Plugin.onHandleContent(content, _filePath);
        
        log.info('write', _filePath);
        fs.outputFileSync(_filePath, content, option);
      };

      const copy = (srcPath, destPath) => {
        const _destPath = path.resolve(config.destination, destPath);
        log.info('copy', _destPath);
        fs.copySync(srcPath, _destPath);
      };

      const read = (filePath) => {
        const _filePath = path.resolve(config.destination, filePath);
        return fs.readFileSync(_filePath).toString();
      };

      Plugin.onPublish(write, copy, read);
    } catch (e) {
      InvalidCodeLogger.showError(e);
      process.exit(1);
    }
  }

  /**
   * show memory usage stat
   * @return {undefined} no return
   */
  static _memUsage() {
    const used = process.memoryUsage();
    Object.keys(used).forEach(key => {
      log.verbose(`${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
    });
  }
}
