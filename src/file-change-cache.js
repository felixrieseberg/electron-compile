import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import pify from 'pify';
import _ from 'lodash';

const pfs = pify(fs);
const pzlib = pify(zlib);

export default class FileChangedCache {
  constructor(appRoot, failOnCacheMiss=false) {
    this.appRoot = appRoot;
    this.failOnCacheMiss = failOnCacheMiss;
    this.changeCache = {};
  }

  static async loadFromFile(file, failOnCacheMiss=true) {
    let ret = new FileChangedCache(failOnCacheMiss);
    let buf = await pfs.readFile(file);
    
    ret.changeCache = JSON.parse(await pzlib.gunzip(buf));
    return ret;
  }
  
  async getHashForPath(absoluteFilePath) {
    let cacheKey = this.appRoot ? absoluteFilePath.replace(this.appRoot, '') : absoluteFilePath;
    let cacheEntry = this.changeCache[cacheKey];
    
    if (this.failOnCacheMiss) {
      if (!cacheEntry) throw new Error(`Asked for ${absoluteFilePath} but it was not precompiled!`);
      return cacheEntry.info;
    }
        
    let stat = await pfs.stat(absoluteFilePath);
    let ctime = stat.ctime.getTime();
    let size = stat.size;
    if (!stat || !stat.isFile()) throw new Error(`Can't stat ${absoluteFilePath}`);
    
    if (cacheEntry) {
      if (cacheEntry.ctime >= ctime && cacheEntry.size === size) {
        return cacheEntry.info;
      }
      
      delete this.changeCache.cacheEntry;
    }
    
    let {digest, sourceCode, binaryData} = await this.calculateHashForFile(absoluteFilePath);
    
    let info = {
      hash: digest,
      isMinified: FileChangedCache.contentsAreMinified(sourceCode || ''),
      isInNodeModules: FileChangedCache.isInNodeModules(absoluteFilePath),
      hasSourceMap: FileChangedCache.hasSourceMap(sourceCode || ''),
      isFileBinary: !!binaryData
    };
    
    this.changeCache[cacheKey] = { ctime, size, info };
    if (binaryData) {
      return _.extend({binaryData}, info);
    } else {
      return _.extend({sourceCode}, info);
    }
  }

  getHashForPathSync(absoluteFilePath) {
    let cacheKey = this.appRoot ? absoluteFilePath.replace(this.appRoot, '') : absoluteFilePath;
    let cacheEntry = this.changeCache[cacheKey];
    
    if (this.failOnCacheMiss) {
      if (!cacheEntry) throw new Error(`Asked for ${absoluteFilePath} but it was not precompiled!`);
      return cacheEntry.info;
    }
        
    let stat = fs.statSync(absoluteFilePath);
    let ctime = stat.ctime.getTime();
    let size = stat.size;
    if (!stat || !stat.isFile()) throw new Error(`Can't stat ${absoluteFilePath}`);
    
    if (cacheEntry) {
      if (cacheEntry.ctime >= ctime && cacheEntry.size === size) {
        return cacheEntry.info;
      }
      
      delete this.changeCache.cacheEntry;
    }
    
    let {digest, sourceCode, binaryData} = this.calculateHashForFileSync(absoluteFilePath);
    
    let info = {
      hash: digest,
      isMinified: FileChangedCache.contentsAreMinified(sourceCode || ''),
      isInNodeModules: FileChangedCache.isInNodeModules(absoluteFilePath),
      hasSourceMap: FileChangedCache.hasSourceMap(sourceCode || ''),
      isFileBinary: !!binaryData
    };
    
    this.changeCache[cacheKey] = { ctime, size, info };
    if (binaryData) {
      return _.extend({binaryData}, info);
    } else {
      return _.extend({sourceCode}, info);
    }
  }

  async save(filePath) {
    let buf = await pzlib.gzip(new Buffer(JSON.stringify(this.changeCache)));
    await pfs.writeFile(filePath, buf);
  }
  
  async calculateHashForFile(absoluteFilePath) {
    let buf = await pfs.readFile(absoluteFilePath);
    let encoding = FileChangedCache.detectFileEncoding(buf);
    
    if (!encoding) {
      let digest = crypto.createHash('sha1').update(buf).digest('hex');
      return { sourceCode: null, digest, binaryData: buf };
    }
    
    let sourceCode = await pfs.readFile(absoluteFilePath, encoding);
    let digest = crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');
    
    return {sourceCode, digest, binaryData: null };
  }
    
  calculateHashForFileSync(absoluteFilePath) {
    let buf = fs.readFileSync(absoluteFilePath);
    let encoding = FileChangedCache.detectFileEncoding(buf);
    
    if (!encoding) {
      let digest = crypto.createHash('sha1').update(buf).digest('hex');
      return { sourceCode: null, digest, binaryData: buf};
    }
    
    let sourceCode = fs.readFileSync(absoluteFilePath, encoding);
    let digest = crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');
    
    return {sourceCode, digest, binaryData: null};  
  }
  
  static contentsAreMinified(source) {
    let length = source.length;
    if (length > 1024) length = 1024;

    let newlineCount = 0;

    // Roll through the characters and determine the average line length
    for(let i=0; i < source.length; i++) {
      if (source[i] === '\n') newlineCount++;
    }

    // No Newlines? Any file other than a super small one is minified
    if (newlineCount === 0) {
      return (length > 80);
    }

    let avgLineLength = length / newlineCount;
    return (avgLineLength > 80);
  }

  static isInNodeModules(filePath) {
    return !!(filePath.match(/[\\\/]node_modules[\\\/]/i) || filePath.match(/[\\\/]atom\.asar/));
  }

  static hasSourceMap(sourceCode) {
    return sourceCode.lastIndexOf('//# sourceMap') > sourceCode.lastIndexOf('\n');
  }
  
  static detectFileEncoding(buffer) {
    if (buffer.length < 1) return true;
    let buf = (buffer.length < 4096 ? buffer : buffer.slice(0, 4096));
    
    const encodings = ['utf8', 'utf16le'];
    
    let encoding = _.find(
      encodings, 
      (x) => !FileChangedCache.containsControlCharacters(buf.toString(x)));
    
    return encoding;
  }
  
  static containsControlCharacters(str) {
    let controlCount = 0;
    
    for (let i=0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c === 65536 || c < 8) controlCount++;
      
      if (controlCount > 16) return true;
    }
    
    if (controlCount === 0) return false;
    return (controlCount / str.length) < 0.02;
  }
}
