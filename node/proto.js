'use strict';

// Minimal protobuf wire-format writer/reader for the raw CM messages that
// steam-user does not ship schemas for (ClientGetTicketForWebApi & friends).

function writeVarint(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}

function tag(field, wireType) {
  return writeVarint((field << 3) | wireType);
}

function fieldVarint(field, value) {
  return Buffer.concat([tag(field, 0), writeVarint(value)]);
}

function fieldFixed64(field, value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([tag(field, 1), b]);
}

function fieldBytes(field, buf) {
  return Buffer.concat([tag(field, 2), writeVarint(buf.length), buf]);
}

function fieldString(field, str) {
  return fieldBytes(field, Buffer.from(str, 'utf8'));
}

// Reads a protobuf buffer into [{field, wire, varint?, bytes?}] entries.
function readFields(buf) {
  const fields = [];
  let off = 0;
  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (off >= buf.length) throw new Error('varint overrun');
      const b = buf[off++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return result;
  };

  while (off < buf.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 0x7n);
    if (wire === 0) {
      fields.push({ field, wire, varint: readVarint() });
    } else if (wire === 1) {
      fields.push({ field, wire, bytes: buf.slice(off, off + 8) });
      off += 8;
    } else if (wire === 2) {
      const len = Number(readVarint());
      fields.push({ field, wire, bytes: buf.slice(off, off + len) });
      off += len;
    } else if (wire === 5) {
      fields.push({ field, wire, bytes: buf.slice(off, off + 4) });
      off += 4;
    } else {
      throw new Error(`unsupported wire type ${wire} on field ${field}`);
    }
  }
  return fields;
}

module.exports = { writeVarint, fieldVarint, fieldFixed64, fieldBytes, fieldString, readFields };
