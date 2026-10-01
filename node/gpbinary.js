'use strict';

// GpBinaryV16 serializer/deserializer (from the game's decompiled Photon3Unity3D.dll).

const T = {
  Unknown: 0, Array: 121, Boolean: 111, Byte: 98, ByteArray: 120, ObjectArray: 122,
  Short: 107, Float: 102, Dictionary: 68, Double: 100, Hashtable: 104, Integer: 105,
  IntegerArray: 110, Long: 108, String: 115, StringArray: 97, Custom: 99, Null: 42,
  EventData: 101, OperationRequest: 113, OperationResponse: 112
};

function serString(s) {
  const b = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(2 + b.length);
  out.writeUInt16BE(b.length, 0);
  b.copy(out, 2);
  return out;
}

function serValue(v) {
  if (v === null || v === undefined) return Buffer.from([T.Null]);
  if (typeof v === 'boolean') return Buffer.from([T.Boolean, v ? 1 : 0]);
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      const b = Buffer.alloc(5);
      b[0] = T.Integer;
      b.writeInt32BE(v, 1);
      return b;
    }
    const b = Buffer.alloc(9);
    b[0] = T.Double;
    b.writeDoubleBE(v, 1);
    return b;
  }
  if (typeof v === 'string') return Buffer.concat([Buffer.from([T.String]), serString(v)]);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.alloc(5);
    b[0] = T.ByteArray;
    b.writeUInt32BE(v.length, 1);
    return Buffer.concat([b, Buffer.from(v)]);
  }
  if (Array.isArray(v)) {
    const parts = v.map(serValue);
    const head = Buffer.alloc(3);
    head[0] = T.ObjectArray;
    head.writeUInt16BE(v.length, 1);
    return Buffer.concat([head, ...parts]);
  }
  if (v && typeof v.__byte === 'number') return Buffer.from([T.Byte, v.__byte & 0xff]);
  if (v && v.__intArray) {
    const arr = v.__intArray;
    const body = Buffer.alloc(5 + arr.length * 4);
    body[0] = T.IntegerArray;
    body.writeUInt32BE(arr.length * 4, 1);
    arr.forEach((n, i) => body.writeInt32BE(n, 5 + i * 4));
    return body;
  }
  if (v && v.__dict) {
    const entries = Object.entries(v.__dict);
    const head = Buffer.from([T.Dictionary, T.String, T.Unknown]);
    const cnt = Buffer.alloc(2);
    cnt.writeUInt16BE(entries.length, 0);
    const parts = [head, cnt];
    for (const [k, val] of entries) {
      parts.push(serString(k));
      parts.push(serValue(val));
    }
    return Buffer.concat(parts);
  }
  if (v && v.__hashtable) {
    const entries = Object.entries(v.__hashtable);
    const head = Buffer.from([T.Hashtable]);
    const cnt = Buffer.alloc(2);
    cnt.writeUInt16BE(entries.length, 0);
    const parts = [head, cnt];
    for (const [k, val] of entries) {
      parts.push(serValue(isNaN(Number(k)) ? k : { __byte: Number(k) }));
      parts.push(serValue(val));
    }
    return Buffer.concat(parts);
  }
  throw new Error('cannot serialize value of type ' + typeof v);
}

function serParams(params) {
  const keys = Object.keys(params);
  const out = [Buffer.alloc(2)];
  out[0].writeUInt16BE(keys.length, 0);
  for (const k of keys) {
    out.push(Buffer.from([Number(k) & 0xff]));
    out.push(serValue(params[k]));
  }
  return Buffer.concat(out);
}

class Reader {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  u8() { return this.buf[this.pos++]; }
  u16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i16() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  f32() { const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  bytes(n) { const v = this.buf.slice(this.pos, this.pos + n); this.pos += n; return v; }

  string() {
    const len = this.u16();
    return this.bytes(len).toString('utf8');
  }

  value(forcedType) {
    const type = forcedType !== undefined ? forcedType : this.u8();
    switch (type) {
      case T.Null: return null;
      case T.Boolean: return this.u8() !== 0;
      case T.Byte: return this.u8();
      case T.Short: return this.i16();
      case T.Integer: return this.i32();
      case T.Long: return Number(this.i64());
      case T.Float: return this.f32();
      case T.Double: return this.f64();
      case T.String: return this.string();
      case T.ByteArray: return this.bytes(this.u32());
      case T.IntegerArray: {
        const n = Math.floor(this.u32() / 4);
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.i32();
        return out;
      }
      case T.StringArray: {
        const n = this.u16();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.string();
        return out;
      }
      case T.ObjectArray: {
        const n = this.u16();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.value();
        return out;
      }
      case T.Array: {
        const elType = this.u8();
        const n = this.u16();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.value(elType);
        return out;
      }
      case T.Hashtable: {
        const n = this.u16();
        const out = {};
        for (let i = 0; i < n; i++) {
          const k = this.value();
          out[k] = this.value();
        }
        return out;
      }
      case T.Dictionary: {
        const kt = this.u8();
        const vt = this.u8();
        const n = this.u16();
        const out = {};
        for (let i = 0; i < n; i++) {
          const k = this.value(kt === T.Unknown ? undefined : kt);
          out[k] = this.value(vt === T.Unknown ? undefined : vt);
        }
        return out;
      }
      case T.Custom: {
        const code = this.u8();
        const len = this.u32();
        return { __custom: code, data: this.bytes(len) };
      }
      default:
        throw new Error(`deserialize: unknown type ${type} at ${this.pos}`);
    }
  }

  params() {
    const n = this.u16();
    const out = {};
    for (let i = 0; i < n; i++) {
      const key = this.u8();
      out[key] = this.value();
    }
    return out;
  }
}

module.exports = { T, serString, serValue, serParams, Reader };
