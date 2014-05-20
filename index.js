'use strict';

var ndarray = require('ndarray');
var websocket_stream = require('websocket-stream');
var minecraft_protocol = require('minecraft-protocol');
var ever = require('ever');
var webworkify = require('webworkify');
var tellraw2dom = require('tellraw2dom');
var bit_twiddle = require('bit-twiddle');
var popCount = bit_twiddle.popCount;

module.exports = function(game, opts) {
  return new ClientMC(game, opts);
};

module.exports.pluginInfo = {
  loadAfter: ['voxel-land', 'voxel-player', 'voxel-registry', 'voxel-console']
};


function ClientMC(game, opts) {
  this.game = game;
  this.opts = opts;

  this.registry = game.plugins.get('voxel-registry');
  if (!this.registry) throw new Error('voxel-clientmc requires voxel-registry plugin');

  this.console = game.plugins.get('voxel-console'); // optional

  opts.url = opts.url || 'ws://'+document.location.hostname+':1234';

  // map http://minecraft.gamepedia.com/Data_values#Block_IDs to our block names
  opts.mcBlocks = opts.mcBlocks || {
      0: 'air',
      1: 'stone',
      2: 'grass',
      3: 'dirt',
      4: 'cobblestone',
      5: 'plankOak',

      7: 'obsidian',   // bedrock

      16: 'oreCoal',

      17: 'logOak',
      18: 'leavesOak',

      161: 'leavesOak',
      162: 'logOak',

      default: 'brick',
  };
    
  this.mcPlayerHeight = 1.74; // from https://github.com/superjoe30/mineflayer/blob/4daa1f8a1f4282755b723df4bb748f6602784744/lib/plugins/physics.js#L23 - tested with a binary search

  this.enable();
}

ClientMC.prototype.enable = function() {
  this.log('voxel-clientmc initializing...');

  this.game.plugins.disable('voxel-land');   // also provides chunks, use ours instead
  //this.game.plugins.get('voxel-player').homePosition = [-248, 77, -198] // can't do this TODO
  //this.game.plugins.get('voxel-player').moveTo -251, 81, -309
  this.game.plugins.enable('voxel-fly');

  this.ws = websocket_stream(this.opts.url, {type: Uint8Array});

  this.game.voxels.on('missingChunk', this.missingChunk.bind(this));

  this.voxelChunks = {};

  // WebSocket to server proxy (wsmc)
  var self = this;
  this.ws.on('error', function(err) {
    self.log('WebSocket error', err);
    self.game.plugins.disable('voxel-clientmc');
  });
  this.ws.on('end', function() {
    self.log('WebSocket end');
    self.game.plugins.disable('voxel-clientmc');
  });

  this.ws.on('data', function(data) {
    var packet = self.decodePacket(data);
    if (!packet) {
      return;
    }

    self.handlePacket(packet.name, packet.payload);
  });

  if (this.console) this.console.widget.on('input', this.onConsoleInput = function(text) {
    self.sendChat(text);
  });

  // chunk decompression
  this.zlib_worker = webworkify(require('./zlib_worker.js'));
  ever(this.zlib_worker).on('message', this.onDecompressed.bind(this));
  this.packetPayloadsPending = {};
  this.packetPayloadsNextID = 0;

  var maxId = 255; // TODO: 4096?

  // array MC block ID -> our block ID
  // TODO: also support .metadata (MC block ID = 12-bits, meta = 4-bits, total 16-bits -> ours 16 bit)
  this.translateBlockIDs = new this.game.arrayType(maxId);
  for (var mcID = 0; mcID < this.translateBlockIDs.length; mcID += 1) {
    this.translateBlockIDs[mcID] = this.registry.getBlockIndex(this.opts.mcBlocks.default);
  }

  for (mcID in this.opts.mcBlocks) {
    var ourBlockName = this.opts.mcBlocks[mcID];
    var ourBlockID = this.registry.getBlockIndex(ourBlockName);
    if (ourBlockID === undefined)
      throw new Error('voxel-clientmc unrecognized block name: '+ourBlockName+' for MC '+mcID);
    this.translateBlockIDs[mcID] = ourBlockID;
  }

  // for chunk conversion - see voxel/chunker.js
  this.chunkBits = Math.log(this.game.chunkSize) / Math.log(2); // must be power of two
  this.chunkBits |= 0;
  this.chunkMask = (1 << this.chunkBits) - 1;
};

ClientMC.prototype.disable = function() {
  this.log('voxel-clientmc disabling');
  this.game.voxels.removeListener('missingChunk', this.missingChunk);
  this.game.plugins.get('voxel-console').widget.removeListener('input', this.onConsoleInput);
  this.ws.end();
  if (this.clearPositionUpdateTimer) this.clearPositionUpdateTimer();
};

ClientMC.prototype.decodePacket = function(data) { // based on https://github.com/deathcap/wsmc/tree/master/examples/mcwebchat
  if (!(data instanceof Uint8Array)) {
    return undefined;
  }

  // convert typed array to NodeJS buffer for minecraft-protocol's API
  // TODO: is this conversion fast? backed by ArrayBuffer in Browserify 3, see https://npmjs.org/package/native-buffer-browserify
  //  but is this the right way to "convert" from an ArrayBuffer to a Buffer, without copying?
  data._isBuffer = true;
  var buffer = new Buffer(data);


  var state = 'play';
  var isServer = false;
  var packetsToParse = {packet: true};
  var result = minecraft_protocol.protocol.parsePacket(buffer, state, isServer, packetsToParse);
  if (!result || result.error) {
    this.log('protocol parse error: ' + JSON.stringify(result.error));
    return undefined;
  }

  var payload = result.results;
  var id = result.results.id;
  var name = minecraft_protocol.protocol.packetNames[minecraft_protocol.protocol.states.PLAY].toClient[id];

  return {name:name, id:id, payload:payload};
};


// call the browser console.log() function with arguments as an array
ClientMC.prototype.nativeConsoleLog = function(args) {
  Function.prototype.bind.call(console.log, console).apply(console, args); // see http://stackoverflow.com/questions/5538972
};

// log to browser and to user console if available
ClientMC.prototype.log = function(msg) {
  var rest = []; //arguments.slice(1); // TODO
  this.nativeConsoleLog(['[voxel-clientmc] ' + msg].concat(rest));  // as separate parameters to allow object expansion
  if (this.console) this.console.log(msg + ' ' + rest.join(' '));
};

ClientMC.prototype.handlePacket = function(name, payload) {
  var self = this;

  if (name === 'map_chunk_bulk') {
    this.log('payload.compressedChunkData ',payload.compressedChunkData.length,payload.compressedChunkData);

    //require('zlib').inflate(payload.compressedChunkData, function(err, decompressed) {
    //  self.log('NON-WORKER decomp=',err+'',decompressed);
    //};

    var id = this.packetPayloadsNextID;
    this.packetPayloadsPending[id] = payload; // save for continued processing in onDecompressed
    this.packetPayloadsNextID += 1;
    // send the ArrayBuffer as a transferrable, along with any possible offsets/length within the data view
    var compressed = payload.compressedChunkData.buffer;
    var byteLength = payload.compressedChunkData.byteLength;
    var byteOffset = payload.compressedChunkData.byteOffset;
    this.log('sending compressedBuffer ',byteLength);
    this.zlib_worker.postMessage({
      id:id,
      compressed:compressed,
      byteOffset:byteOffset,
      byteLength:byteLength}, [compressed]);
 
  } else if (name === 'spawn_position') {
    // move to spawn TODO: this might only reset the compass 
    this.log('Spawn at ',payload);
    this.game.plugins.get('voxel-player').moveTo(payload.x, payload.y, payload.z);
    //this.game.plugins.get('voxel-player').homePosition = [-248, 77, -198] # can't do this TODO
    
    this.setupPositionUpdates();  // TODO: now or when?
  
  } else if (name === 'block_change') {
    this.log('block_change',payload);
    var blockID = this.translateBlockIDs[payload.type]; //  TODO: .metadata
    this.game.setBlock([payload.x, payload.y, payload.z], blockID);

  } else if (name === 'position') {
    // TODO, yaw, pitch. to convert see http://wiki.vg/Protocol#Player_Position_And_Look
    this.log('player pos and look', payload);
    var ourY = payload.y - 1.62; // empirical  TODO: not playerHeight?
    this.game.plugins.get('voxel-player').moveTo(payload.x, ourY, payload.z);

    // the "apology"
    this.sendPacket('position', payload);

  } else if (name === 'kick_disconnect') {
    window.alert('Disconnected from server: '+payload.reason); // TODO: console, also for chat
  } else if (name === 'chat') {
    // log formatted message
    this.game.plugins.get('voxel-console').logNode(tellraw2dom(payload.message));
  }
};

ClientMC.prototype.sendChat = function(text) {
  this.sendPacket('chat', {message: text});
};

// setup timer to send player position updates to the server
ClientMC.prototype.setupPositionUpdates = function() {
  // MC requires every 50 ms (server = 20 ticks/second)
  this.clearPositionUpdateTimer = this.game.setInterval(this.sendPositionUpdate.bind(this), 50);
};

ClientMC.prototype.sendPositionUpdate = function() {
  var pos = this.game.plugins.get('voxel-player').yaw.position;
  if (!pos) return;

  var x = pos.x;
  var y = pos.y + 1;
  var z = pos.z;

  var stance = y + this.mcPlayerHeight;
  var onGround = true;

  this.sendPacket('position', {
    x:x,
    y:y,
    z:z,
    stance:stance,
    onGround:onGround});
};

ClientMC.prototype.sendPacket = function(name, params) {
  var state = 'play';
  var data = minecraft_protocol.protocol.createPacketBuffer(name, state, params);
  this.ws.write(data); // TODO: handle error
};

ClientMC.prototype.onDecompressed = function(ev) {
  this.log('onDecompressed',ev);

  var id = ev.data.id;
  var payload = this.packetPayloadsPending[id];
  delete this.packetPayloadsPending[id];

  if (ev.data.err) {
    this.log('received decompression error',ev.data.err,' for ',ev.data.id);
    return;
  }

  var inflated = new Buffer(new Uint8Array(ev.data.decompressed));// new Buffer() for .slice method below. TODO: replace with typed array alternative
  this.log('  decomp', id, inflated.length);

  // unpack chunk data
  // based on https://github.com/superjoe30/mineflayer/blob/cc3eae10f622da24c9051268e9fc8ec3fe01ed7e/lib/plugins/blocks.js#L195
  // and http://wiki.vg/SMP_Map_Format#Data
  var offset = 0;
  var meta = 0;
  var size = 0;
  for (var i = 0; i < payload.meta.length; i += 1) {
    meta = payload.meta[i];
    size = (8192 + (payload.skyLightSent ? 2048 : 0)) *
      popCount(meta.bitMap) +
      2048 * popCount(meta.addBitMap) + 256;
    this.addColumn({
      x: meta.x,
      z: meta.z,
      bitMap: meta.bitMap,
      addBitMap: meta.addBitMap,
      skyLightSent: payload.skyLightSent,
      groundUp: true,
      data: inflated.slice(offset, offset + size),
    });
    offset += size;
  }

  if (offset !== inflated.length) {
    this.log('incomplete chunk decode: '+offset+' != '+inflated.length);
  }
};


// convert MC chunk format to ours, caching to be ready for missingChunk()
ClientMC.prototype.addColumn = function(args) {
  var chunkX = args.x;
  var chunkZ = args.z;

  var offset = 0;
  var size = 4096;
  for (var chunkY = 0; chunkY <= 16; chunkY += 1) {
    if (args.bitMap & (1 << chunkY)) {
      var miniChunk = args.data.slice(offset, offset + size);
      offset += size;

      // convert MC's chunks to voxel-engine's
      // TODO: speed this up somehow
      for (var dy = 0; dy <= 16; dy += 1) {
        var y = chunkY*16 + dy;
        for (var dz = 0; dz <= 16; dz += 1) {
          var z = chunkZ*16 + dz;
          for (var dx = 0; dx <= 16; dx += 1) {
            var x = chunkX*16 + dx;

            // MC uses XZY ordering, 16x16x16 mini-chunks
            var mcBlockID = miniChunk[dx + dz*16 + dy*16*16];

            // voxel-engine uses XYZ, (by default) 32x32x32
            // calculate chunk coordinates
            var vchunkKey = (x >> this.chunkBits) + '|' + (y >> this.chunkBits) + '|' + (z >> this.chunkBits);
            if (!(vchunkKey in this.voxelChunks))
              this.voxelChunks[vchunkKey] = new this.game.arrayType(this.game.chunkSize * this.game.chunkSize * this.game.chunkSize);

            var ourBlockID = this.translateBlockIDs[mcBlockID];

            // our block offsets within the chunk, scaled
            var vindex = (x & this.chunkMask) + ((y & this.chunkMask) << this.chunkBits) + ((z & this.chunkMask) << this.chunkBits * 2);
            this.voxelChunks[vchunkKey][vindex] = ourBlockID;
          }
        }
      }
    } else {
      // entirely air
    }
  }

  // TODO: metadata,light,sky,add,biome
};

ClientMC.prototype.missingChunk = function(pos) {
  var voxels = this.voxelChunks[pos.join('|')];
  if (voxels === undefined) return;

  var shape = [this.game.chunkSize, this.game.chunkSize, this.game.chunkSize];

  var chunk;
  if (!this.game.voxels.voxelIndex) { // ndarray voxel removes this in https://github.com/maxogden/voxel/pull/18 TODO: better detection?
    chunk = ndarray(voxels, shape);
    chunk.position = pos;
  } else {
    // pre-ndarray format TODO: support this too in ndarray voxel?
    chunk = {
      position: pos,
      dims: shape,
      voxels: voxels,
    };
  }

  this.game.showChunk(chunk);
};


