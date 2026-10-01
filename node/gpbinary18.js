'use strict';

// GpBinaryV18 serializer/deserializer (from the live game's Photon3Unity3D.dll,
// Protocol18). Little-endian numerics, LEB128 varints, zigzag compressed ints,
// varint length prefixes, 1-byte bool/zero type tags.

const T18 = {
  Unknown: 0, Boolean: 2, Byte: 3, Short: 4, Float: 5, Double: 6, String: 7,
  Null: 8, CompressedInt: 9, CompressedLong: 10, Int1: 11, Int1_: 12,
  Int2: 13, Int2_: 14, L1: 15, L1_: 16, L2: 17, L2_: 18, Custom: 19,
  Dictionary: 20, Hashtable: 21, ObjectArray: 23, OperationRequest: 24,
  OperationResponse: 25, EventData: 26, BooleanFalse: 27, BooleanTrue: 28,
  ShortZero: 29, IntZero: 30, LongZero: 31, FloatZero: 32, DoubleZero: 33,
  ByteZero: 34, Array: 64, BooleanArray: 66, ByteArray: 67, ShortArray: 68,
  FloatArray: 69, DoubleArray: 70, StringArray: 71, CompressedIntArray: 73,
  CompressedLongArray: 74, CustomTypeArray: 83, DictionaryArray: 84, HashtableArray: 85
};

// ------------------------------------------------------------ varint helpers

function writeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}

function zigzag32(n) { return (n << 1) ^ (n >> 31); }
function zigzag64(n) { return (BigInt(n) << 1n) ^ (BigInt(n) >> 63n); }

// ---------------------------------------------------------------- serializer

function serString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarint(b.length), b]);
}

// typed value (with type byte), mirrors Write(stream, value, writeType: true)
// float serialization (GpType.Float = 5, 4-byte LE) — colors etc. MUST arrive
// as boxed floats or C# (float)data[i] casts throw and rig instantiation dies
function serFloat(n) {
  const b = Buffer.alloc(5);
  b[0] = T18.Float;
  b.writeFloatLE(n, 1);
  return b;
}

// Int16 — required for VRRig.packedCompetitiveData / arm shorts.
// C# does `(short)stream.ReceiveNext()`; a boxed Int32 throws and aborts
// OnSerializeRead before SerializeReadShared ever runs (rig never moves).
function serShort(n) {
  n = n | 0;
  if (n > 32767) n = 32767;
  if (n < -32768) n = -32768;
  if (n === 0) return Buffer.from([T18.ShortZero]);
  const b = Buffer.alloc(3);
  b[0] = T18.Short;
  b.writeInt16LE(n, 1);
  return b;
}

function serValue(v) {
  if (v === null || v === undefined) return Buffer.from([T18.Null]);
  if (typeof v === 'boolean') return Buffer.from([v ? T18.BooleanTrue : T18.BooleanFalse]);
  if (typeof v === 'number') return Number.isInteger(v) ? serInt(v) : serFloat(v);
  if (typeof v === 'bigint') return serLong(v);
  if (typeof v === 'string') return Buffer.concat([Buffer.from([T18.String]), serString(v)]);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return Buffer.concat([Buffer.from([T18.ByteArray]), writeVarint(v.length), Buffer.from(v)]);
  }
  if (Array.isArray(v)) {
    const parts = v.map(serValue);
    return Buffer.concat([Buffer.from([T18.ObjectArray]), writeVarint(v.length), ...parts]);
  }
  if (v && typeof v.__byte === 'number') {
    if (v.__byte === 0) return Buffer.from([T18.ByteZero]);
    return Buffer.from([T18.Byte, v.__byte & 0xff]);
  }
  if (v && typeof v.__short === 'number') return serShort(v.__short);
  if (v && v.__vector3) {
    // custom type 'V' (0x56): 12 bytes = 3 floats LE (x,y,z)
    const b = Buffer.alloc(12);
    b.writeFloatLE(v.__vector3[0], 0);
    b.writeFloatLE(v.__vector3[1], 4);
    b.writeFloatLE(v.__vector3[2], 8);
    return Buffer.concat([Buffer.from([T18.Custom, 0x56]), writeVarint(12), b]);
  }
  if (v && v.__quaternion) {
    // custom type 'Q' (0x51): 16 bytes = 4 floats LE (w,x,y,z)
    const b = Buffer.alloc(16);
    b.writeFloatLE(v.__quaternion[0], 0);  // w
    b.writeFloatLE(v.__quaternion[1], 4);  // x
    b.writeFloatLE(v.__quaternion[2], 8);  // y
    b.writeFloatLE(v.__quaternion[3], 12); // z
    return Buffer.concat([Buffer.from([T18.Custom, 0x51]), writeVarint(16), b]);
  }
  if (v && v.__custom !== undefined && (Buffer.isBuffer(v.data) || v.data instanceof Uint8Array)) {
    // faithful round-trip of an opaque custom type (needed to mirror rig views)
    const data = Buffer.from(v.data);
    return Buffer.concat([Buffer.from([T18.Custom, v.__custom & 0xff]), writeVarint(data.length), data]);
  }
  if (v && v.__intArray) {
    // CompressedIntArray: varint count + zigzag varints
    const parts = v.__intArray.map((n) => writeVarint(zigzag32(n | 0) >>> 0));
    return Buffer.concat([Buffer.from([T18.CompressedIntArray]), writeVarint(v.__intArray.length), ...parts]);
  }
  if (v && v.__dict) {
    const entries = Object.entries(v.__dict);
    const parts = [
      Buffer.from([T18.Dictionary, T18.String, T18.Unknown]),
      writeVarint(entries.length)
    ];
    for (const [k, val] of entries) {
      parts.push(serString(k));
      parts.push(serValue(val));
    }
    return Buffer.concat(parts);
  }
  if (v && v.__bdict) {
    // Dictionary<byte, object>: raw byte keys, self-typed values (Photon Voice VoiceInfo)
    const entries = Object.entries(v.__bdict);
    const parts = [
      Buffer.from([T18.Dictionary, T18.Byte, T18.Unknown]),
      writeVarint(entries.length)
    ];
    for (const [k, val] of entries) {
      parts.push(Buffer.from([Number(k) & 0xff]));
      parts.push(serValue(val));
    }
    return Buffer.concat(parts);
  }
  if (v && v.__hashtable) {
    const entries = Object.entries(v.__hashtable);
    const parts = [Buffer.from([T18.Hashtable]), writeVarint(entries.length)];
    for (const [k, val] of entries) {
      parts.push(serValue(isNaN(Number(k)) ? k : { __byte: Number(k) }));
      parts.push(serValue(val));
    }
    return Buffer.concat(parts);
  }
  throw new Error('v18: cannot serialize ' + Object.prototype.toString.call(v));
}

// int serialization with compact forms (WriteCompressedInt32 with writeType)
function serInt(n) {
  n = n | 0;
  if (n === 0) return Buffer.from([T18.IntZero]);
  if (n > 0) {
    if (n <= 255) return Buffer.from([T18.Int1, n]);
    if (n <= 65535) {
      const b = Buffer.alloc(3);
      b[0] = T18.Int2;
      b.writeUInt16LE(n, 1);
      return b;
    }
  } else if (n >= -65535) {
    if (n >= -255) return Buffer.from([T18.Int1_, -n]);
    const b = Buffer.alloc(3);
    b[0] = T18.Int2_;
    b.writeUInt16LE(-n, 1);
    return b;
  }
  return Buffer.concat([Buffer.from([T18.CompressedInt]), writeVarint(zigzag32(n) >>> 0)]);
}

function serLong(n) {
  n = BigInt(n);
  if (n === 0n) return Buffer.from([T18.LongZero]);
  if (n > 0n) {
    if (n <= 255n) return Buffer.from([T18.L1, Number(n)]);
    if (n <= 65535n) {
      const b = Buffer.alloc(3);
      b[0] = T18.L2;
      b.writeUInt16LE(Number(n), 1);
      return b;
    }
  } else if (n >= -65535n) {
    if (n >= -255n) return Buffer.from([T18.L1_, Number(-n)]);
    const b = Buffer.alloc(3);
    b[0] = T18.L2_;
    b.writeUInt16LE(Number(-n), 1);
    return b;
  }
  return Buffer.concat([Buffer.from([T18.CompressedLong]), writeVarint(zigzag64(n))]);
}

function serParams(params) {
  const keys = Object.keys(params);
  const out = [writeVarint(keys.length)];
  for (const k of keys) {
    out.push(Buffer.from([Number(k) & 0xff]));
    out.push(serValue(params[k]));
  }
  return Buffer.concat(out);
}

// --------------------------------------------------------------- deserializer

class Reader18 {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  _check(n) {
    if (this.pos + n > this.buf.length) throw new RangeError(`reader overrun: need ${n} at ${this.pos}/${this.buf.length}`);
  }
  u8() { this._check(1); return this.buf[this.pos++]; }
  bytes(n) { this._check(n); const v = this.buf.slice(this.pos, this.pos + n); this.pos += n; return v; }
  varint() {
    let result = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      this._check(1);
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
    throw new RangeError('varint too long');
  }
  u16le() { this._check(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i16le() { this._check(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  f32le() { this._check(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64le() { this._check(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }

  _safeLen(max = 0x10000) {
    const n = Number(this.varint());
    if (n < 0 || n > max) throw new RangeError(`length ${n} exceeds sanity limit ${max}`);
    return n;
  }

  string() {
    const len = this._safeLen();
    return this.bytes(len).toString('utf8');
  }

  value(forcedType) {
    const type = forcedType !== undefined ? forcedType : this.u8();
    switch (type) {
      case T18.Null: return null;
      case T18.Boolean: return this.u8() !== 0;
      case T18.BooleanTrue: return true;
      case T18.BooleanFalse: return false;
      case T18.Byte: return this.u8();
      case T18.ByteZero: return 0;
      case T18.Short: return this.i16le();
      case T18.ShortZero: return 0;
      case T18.Float: return this.f32le();
      case T18.FloatZero: return 0;
      case T18.Double: return this.f64le();
      case T18.DoubleZero: return 0;
      case T18.String: return this.string();
      case T18.CompressedInt: {
        const v = Number(this.varint());
        return (v >>> 1) ^ -(v & 1);
      }
      case T18.Int1: return this.u8();
      case T18.Int1_: return -this.u8();
      case T18.Int2: return this.u16le();
      case T18.Int2_: return -this.u16le();
      case T18.IntZero: return 0;
      case T18.CompressedLong: {
        const v = this.varint();
        // keep C# `long` as BigInt — packed world positions overflow 2^53 and
        // must survive re-serialization (mirroring) without precision loss
        return (v >> 1n) ^ -(v & 1n);
      }
      case T18.L1: return BigInt(this.u8());
      case T18.L1_: return -BigInt(this.u8());
      case T18.L2: return BigInt(this.u16le());
      case T18.L2_: return -BigInt(this.u16le());
      case T18.LongZero: return 0n;
      case T18.ByteArray: return this.bytes(this._safeLen());
      case T18.CompressedIntArray: {
        const n = this._safeLen();
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = Number(this.varint());
          out[i] = (v >>> 1) ^ -(v & 1);
        }
        return out;
      }
      case T18.CompressedLongArray: {
        const n = this._safeLen();
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = this.varint();
          out[i] = (v >> 1n) ^ -(v & 1n);
        }
        return out;
      }
      case T18.StringArray: {
        const n = this._safeLen();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.string();
        return out;
      }
      case T18.ObjectArray: {
        const n = this._safeLen();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.value();
        return out;
      }
      case T18.Hashtable: {
        const n = this._safeLen();
        const out = {};
        for (let i = 0; i < n; i++) {
          const k = this.value();
          out[k] = this.value();
        }
        return out;
      }
      case T18.Dictionary: {
        const kt = this.u8();
        const vt = this.u8();
        const n = this._safeLen();
        const out = {};
        for (let i = 0; i < n; i++) {
          const k = this.value(kt === T18.Unknown ? undefined : kt);
          out[k] = this.value(vt === T18.Unknown ? undefined : vt);
        }
        return out;
      }
      case T18.Custom: {
        const code = this.u8();
        const len = this._safeLen();
        const data = this.bytes(len);
        // decode known custom types for convenience
        if (code === 0x56 && len === 12) { // 'V' Vector3
          return { __vector3: [data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8)] };
        }
        if (code === 0x51 && len === 16) { // 'Q' Quaternion
          return { __quaternion: [data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8), data.readFloatLE(12)] };
        }
        return { __custom: code, data };
      }
      default:
        if (type >= 0x80) {
          // 0x80|code direct custom type: lower 7 bits = code, follows varint length + data
          const code = type & 0x7f;
          const len = this._safeLen();
          const data = this.bytes(len);
          if (code === 0x56 && len === 12) {
            return { __vector3: [data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8)] };
          }
          if (code === 0x51 && len === 16) {
            return { __quaternion: [data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8), data.readFloatLE(12)] };
          }
          return { __custom: code, data };
        }
        // pooled/wrapped variants (>=128, 208/209 etc.) or unknown tags:
        // don't kill the stream over them — caller decides what matters
        return { __unknown: type };
    }
  }

  params() {
    const n = this._safeLen();
    const out = {};
    for (let i = 0; i < n; i++) {
      const key = this.u8();
      out[key] = this.value();
    }
    return out;
  }
}

module.exports = { T18, writeVarint, zigzag32, serString, serValue, serInt, serShort, serFloat, serLong, serParams, Reader18 };
