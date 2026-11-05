// Reads Windows PE files (.dll / .exe) — including .NET assembly metadata —
// and PDB debug files. Pure parsing, no DOM.

export interface PeInfo {
  kind: 'dll' | 'exe';
  machine: string;
  bits: 32 | 64;
  /** Only meaningful for programs. */
  subsystem?: string;
  built?: Date;
  version: Record<string, string>; // FileVersion, ProductName, CompanyName, ...
  sections: { name: string; size: number }[];
  imports: string[];
  dotnet?: DotnetInfo;
}

export interface DotnetInfo {
  /** Has an entry point (Main): a runnable app, even when the file is a .dll (.NET Core / 5+). */
  isApp: boolean;
  runtime: string; // e.g. v4.0.30319
  platform: string; // AnyCPU / x86 / x64 ...
  framework?: string; // .NET Framework 4.7.2
  assembly?: { name: string; version: string; culture: string };
  references: { name: string; version: string }[];
  /**
   * `name`: display name (Outer.Inner for nested types); `fullName`: reflection name
   * (Ns.Outer+Inner); `outer`: full name of the top-level type (what ILSpy decompiles).
   */
  types: { ns: string; name: string; fullName: string; outer: string; isPublic: boolean; methods: string[] }[];
}

export interface PdbInfo {
  format: 'portable' | 'windows';
  sources: string[];
  id?: string;
}

class Reader {
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8 = (o: number) => this.b[o];
  u16 = (o: number) => this.dv.getUint16(o, true);
  u32 = (o: number) => this.dv.getUint32(o, true);
  ascii(o: number, max = 256): string {
    let s = '';
    for (let i = o; i < Math.min(this.b.length, o + max) && this.b[i]; i++) s += String.fromCharCode(this.b[i]);
    return s;
  }
  utf8z(o: number): string {
    let e = o;
    while (e < this.b.length && this.b[e]) e++;
    return new TextDecoder().decode(this.b.subarray(o, e));
  }
  utf16z(o: number, end: number): [string, number] {
    let s = '';
    let i = o;
    for (; i + 1 < end; i += 2) {
      const c = this.u16(i);
      if (!c) {
        i += 2;
        break;
      }
      s += String.fromCharCode(c);
    }
    return [s, i];
  }
}

const MACHINES: Record<number, string> = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'ARM64', 0x1c4: 'ARM', 0x200: 'IA-64' };
const SUBSYSTEMS: Record<number, string> = { 1: 'Native', 2: 'Windows GUI', 3: 'Console', 9: 'Windows CE', 10: 'EFI', 14: 'Xbox' };

export function isPe(b: Uint8Array): boolean {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
  const off = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0x3c, true);
  return off + 4 < b.length && b[off] === 0x50 && b[off + 1] === 0x45 && b[off + 2] === 0 && b[off + 3] === 0;
}

export function parsePe(bytes: Uint8Array): PeInfo {
  const r = new Reader(bytes);
  const pe = r.u32(0x3c);
  const coff = pe + 4;
  const machineId = r.u16(coff);
  const nSections = r.u16(coff + 2);
  const stamp = r.u32(coff + 4);
  const optSize = r.u16(coff + 16);
  const characteristics = r.u16(coff + 18);
  const opt = coff + 20;
  const magic = r.u16(opt);
  const bits = magic === 0x20b ? 64 : 32;
  const subsystem = r.u16(opt + 68);
  const dirBase = opt + (bits === 64 ? 112 : 96);
  const nDirs = r.u32(opt + (bits === 64 ? 108 : 92));
  const dir = (i: number) => (i < nDirs ? { rva: r.u32(dirBase + i * 8), size: r.u32(dirBase + i * 8 + 4) } : { rva: 0, size: 0 });

  const sections: { name: string; va: number; vsize: number; raw: number; rawSize: number }[] = [];
  const secBase = opt + optSize;
  for (let i = 0; i < nSections; i++) {
    const s = secBase + i * 40;
    sections.push({ name: r.ascii(s, 8), vsize: r.u32(s + 8), va: r.u32(s + 12), rawSize: r.u32(s + 16), raw: r.u32(s + 20) });
  }
  const toOff = (rva: number): number => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    }
    return rva < bytes.length ? rva : -1;
  };

  // Build time: deterministic (.NET) builds put a hash here, so only show plausible dates.
  const date = new Date(stamp * 1000);
  const built = stamp && date.getUTCFullYear() >= 1995 && date.getTime() < Date.now() + 86_400_000 ? date : undefined;

  const info: PeInfo = {
    kind: characteristics & 0x2000 ? 'dll' : 'exe',
    machine: MACHINES[machineId] ?? `0x${machineId.toString(16)}`,
    bits,
    subsystem: characteristics & 0x2000 ? undefined : SUBSYSTEMS[subsystem] ?? String(subsystem),
    built,
    version: {},
    sections: sections.map((s) => ({ name: s.name, size: s.vsize })),
    imports: [],
  };

  try {
    info.version = readVersion(r, toOff, dir(2));
  } catch {
    // no / broken version resource
  }
  try {
    info.imports = readImports(r, toOff, dir(1));
  } catch {
    // no imports
  }
  const clr = dir(14);
  if (clr.rva) {
    try {
      info.dotnet = readDotnet(r, toOff, toOff(clr.rva), machineId);
    } catch {
      info.dotnet = { isApp: false, runtime: '?', platform: '?', references: [], types: [] };
    }
    info.dotnet.framework = targetFramework(bytes);
  }
  return info;
}

// ---------- Version resource (FileVersion, CompanyName, ...) ----------

function readVersion(r: Reader, toOff: (rva: number) => number, d: { rva: number; size: number }): Record<string, string> {
  if (!d.rva) return {};
  const base = toOff(d.rva);
  // Resource tree: type (16 = RT_VERSION) → name → language → data entry.
  const find = (dirOff: number, id?: number): number => {
    const named = r.u16(dirOff + 12);
    const ids = r.u16(dirOff + 14);
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8;
      if (id === undefined || r.u32(e) === id) return r.u32(e + 4);
    }
    return -1;
  };
  let entry = find(base, 16);
  if (entry < 0 || !(entry & 0x80000000)) return {};
  entry = find(base + (entry & 0x7fffffff));
  if (entry < 0 || !(entry & 0x80000000)) return {};
  entry = find(base + (entry & 0x7fffffff));
  if (entry < 0 || entry & 0x80000000) return {};
  const data = base + entry;
  const start = toOff(r.u32(data));
  const size = r.u32(data + 4);
  if (start < 0) return {};

  const out: Record<string, string> = {};
  const align = (x: number) => start + ((x - start + 3) & ~3);
  const walk = (off: number, end: number, depth: number) => {
    while (off + 6 < end) {
      const len = r.u16(off);
      if (!len) break;
      const valueLen = r.u16(off + 2);
      const isText = r.u16(off + 4) === 1;
      const blockEnd = Math.min(end, off + len);
      const [key, afterKey] = r.utf16z(off + 6, blockEnd);
      let p = align(afterKey);
      if (depth === 2 && isText && valueLen) {
        const [value] = r.utf16z(p, Math.min(blockEnd, p + valueLen * 2 + 2));
        out[key] = value.trim();
      }
      p = align(p + (isText ? valueLen * 2 : valueLen));
      // StringFileInfo → StringTable (depth 1) → String (depth 2)
      if ((depth === 0 && key === 'StringFileInfo') || depth === 1) walk(p, blockEnd, depth + 1);
      if (depth === -1) walk(p, blockEnd, 0);
      off = align(blockEnd);
    }
  };
  walk(start, start + size, -1); // root VS_VERSIONINFO
  return out;
}

function readImports(r: Reader, toOff: (rva: number) => number, d: { rva: number; size: number }): string[] {
  if (!d.rva) return [];
  const out: string[] = [];
  for (let p = toOff(d.rva); p > 0 && p + 20 <= r.b.length && out.length < 500; p += 20) {
    const nameRva = r.u32(p + 12);
    if (!nameRva && !r.u32(p)) break;
    const o = toOff(nameRva);
    if (o > 0) out.push(r.ascii(o));
  }
  return out;
}

// ---------- .NET metadata (ECMA-335) ----------

type Col = 2 | 4 | 's' | 'g' | 'b' | ['t', number] | ['c', string];
// Column layout of every metadata table (ECMA-335 II.22 + Portable PDB).
const SCHEMA: Record<number, Col[]> = {
  0x00: [2, 's', 'g', 'g', 'g'],
  0x01: [['c', 'ResolutionScope'], 's', 's'],
  0x02: [4, 's', 's', ['c', 'TypeDefOrRef'], ['t', 0x04], ['t', 0x06]],
  0x03: [['t', 0x04]],
  0x04: [2, 's', 'b'],
  0x05: [['t', 0x06]],
  0x06: [4, 2, 2, 's', 'b', ['t', 0x08]],
  0x07: [['t', 0x08]],
  0x08: [2, 2, 's'],
  0x09: [['t', 0x02], ['c', 'TypeDefOrRef']],
  0x0a: [['c', 'MemberRefParent'], 's', 'b'],
  0x0b: [2, ['c', 'HasConstant'], 'b'],
  0x0c: [['c', 'HasCustomAttribute'], ['c', 'CustomAttributeType'], 'b'],
  0x0d: [['c', 'HasFieldMarshal'], 'b'],
  0x0e: [2, ['c', 'HasDeclSecurity'], 'b'],
  0x0f: [2, 4, ['t', 0x02]],
  0x10: [4, ['t', 0x04]],
  0x11: ['b'],
  0x12: [['t', 0x02], ['t', 0x14]],
  0x13: [['t', 0x14]],
  0x14: [2, 's', ['c', 'TypeDefOrRef']],
  0x15: [['t', 0x02], ['t', 0x17]],
  0x16: [['t', 0x17]],
  0x17: [2, 's', 'b'],
  0x18: [2, ['t', 0x06], ['c', 'HasSemantics']],
  0x19: [['t', 0x02], ['c', 'MethodDefOrRef'], ['c', 'MethodDefOrRef']],
  0x1a: ['s'],
  0x1b: ['b'],
  0x1c: [2, ['c', 'MemberForwarded'], 's', ['t', 0x1a]],
  0x1d: [4, ['t', 0x04]],
  0x1e: [4, 4],
  0x1f: [4],
  0x20: [4, 2, 2, 2, 2, 4, 'b', 's', 's'],
  0x21: [4],
  0x22: [4, 4, 4],
  0x23: [2, 2, 2, 2, 4, 'b', 's', 's', 'b'],
  0x24: [4, ['t', 0x23]],
  0x25: [4, 4, 4, ['t', 0x23]],
  0x26: [4, 's', 'b'],
  0x27: [4, 4, 's', 's', ['c', 'Implementation']],
  0x28: [4, 4, 's', ['c', 'Implementation']],
  0x29: [['t', 0x02], ['t', 0x02]],
  0x2a: [2, 2, ['c', 'TypeOrMethodDef'], 's'],
  0x2b: [['c', 'MethodDefOrRef'], 'b'],
  0x2c: [['t', 0x2a], ['c', 'TypeDefOrRef']],
  0x30: ['b', 'g', 'b', 'g'], // Portable PDB: Document
};
const HCA = [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b];
const CODED: Record<string, [bits: number, tables: number[]]> = {
  TypeDefOrRef: [2, [0x02, 0x01, 0x1b]],
  HasConstant: [2, [0x04, 0x08, 0x17]],
  HasCustomAttribute: [5, HCA],
  HasFieldMarshal: [1, [0x04, 0x08]],
  HasDeclSecurity: [2, [0x02, 0x06, 0x20]],
  MemberRefParent: [3, [0x02, 0x01, 0x1a, 0x06, 0x1b]],
  HasSemantics: [1, [0x14, 0x17]],
  MethodDefOrRef: [1, [0x06, 0x0a]],
  MemberForwarded: [1, [0x04, 0x06]],
  Implementation: [2, [0x26, 0x23, 0x27]],
  CustomAttributeType: [3, [0x06, 0x0a]],
  ResolutionScope: [2, [0x00, 0x1a, 0x23, 0x01]],
  TypeOrMethodDef: [1, [0x02, 0x06]],
};

interface Metadata {
  r: Reader;
  version: string;
  streams: Record<string, { off: number; size: number }>;
  rows: number[];
  heapSizes: number;
  tableOff: Record<number, number>;
  rowSize: Record<number, number>;
  colSizes: Record<number, number[]>;
}

/** Reads the metadata root ("BSJB") at `off` and lays out the #~ tables. */
function readMetadata(r: Reader, off: number, extraRows?: number[]): Metadata {
  if (r.u32(off) !== 0x424a5342) throw new Error('no metadata');
  const verLen = r.u32(off + 12);
  const version = r.ascii(off + 16, verLen);
  let p = off + 16 + verLen + 2;
  const nStreams = r.u16(p);
  p += 2;
  const streams: Metadata['streams'] = {};
  for (let i = 0; i < nStreams; i++) {
    const sOff = r.u32(p);
    const size = r.u32(p + 4);
    const name = r.ascii(p + 8, 32);
    streams[name] = { off: off + sOff, size };
    p += 8 + ((name.length + 4) & ~3);
  }
  const tilde = streams['#~'] ?? streams['#-'];
  const rows = new Array(64).fill(0);
  const md: Metadata = { r, version, streams, rows, heapSizes: 0, tableOff: {}, rowSize: {}, colSizes: {} };
  if (!tilde) return md;
  const t = tilde.off;
  md.heapSizes = r.u8(t + 6);
  const validLo = r.u32(t + 8);
  const validHi = r.u32(t + 12);
  let q = t + 24;
  const present: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (i < 32 ? validLo & (1 << i) : validHi & (1 << (i - 32))) {
      rows[i] = r.u32(q);
      q += 4;
      present.push(i);
    }
  }
  // Portable PDBs reference type-system tables that live in the DLL (#Pdb stream row counts).
  if (extraRows) extraRows.forEach((n, i) => (rows[i] = rows[i] || n));
  const idx = (table: number) => (rows[table] < 0x10000 ? 2 : 4);
  const size = (c: Col): number => {
    if (c === 2 || c === 4) return c;
    if (c === 's') return md.heapSizes & 1 ? 4 : 2;
    if (c === 'g') return md.heapSizes & 2 ? 4 : 2;
    if (c === 'b') return md.heapSizes & 4 ? 4 : 2;
    if (c[0] === 't') return idx(c[1]);
    const [bits, tables] = CODED[c[1]];
    const max = Math.max(...tables.map((x) => rows[x] ?? 0));
    return max < 1 << (16 - bits) ? 2 : 4;
  };
  for (const id of present) {
    const schema = SCHEMA[id];
    if (!schema) break; // unknown table: we cannot know where later tables start
    md.colSizes[id] = schema.map(size);
    md.rowSize[id] = md.colSizes[id].reduce((a, b) => a + b, 0);
    md.tableOff[id] = q;
    q += md.rowSize[id] * rows[id];
  }
  return md;
}

/** Value of column `col` (0-based) in 1-based `row` of `table`. */
function cell(md: Metadata, table: number, row: number, col: number): number {
  const off = md.tableOff[table] + (row - 1) * md.rowSize[table] + md.colSizes[table].slice(0, col).reduce((a, b) => a + b, 0);
  return md.colSizes[table][col] === 2 ? md.r.u16(off) : md.r.u32(off);
}
const str = (md: Metadata, i: number) => (md.streams['#Strings'] && i ? md.r.utf8z(md.streams['#Strings'].off + i) : '');
function blob(md: Metadata, i: number): Uint8Array {
  const h = md.streams['#Blob'];
  if (!h || !i) return new Uint8Array();
  let p = h.off + i;
  const b0 = md.r.u8(p);
  let len: number;
  if (!(b0 & 0x80)) [len, p] = [b0, p + 1];
  else if ((b0 & 0xc0) === 0x80) [len, p] = [((b0 & 0x3f) << 8) | md.r.u8(p + 1), p + 2];
  else [len, p] = [((b0 & 0x1f) << 24) | (md.r.u8(p + 1) << 16) | (md.r.u8(p + 2) << 8) | md.r.u8(p + 3), p + 4];
  return md.r.b.subarray(p, p + len);
}

function readDotnet(r: Reader, toOff: (rva: number) => number, cor: number, machine: number): DotnetInfo {
  const flags = r.u32(cor + 16);
  const md = readMetadata(r, toOff(r.u32(cor + 8)));
  const ilOnly = flags & 1;
  const req32 = flags & 2;
  const pref32 = flags & 0x20000;
  const platform =
    machine === 0x14c && ilOnly && !req32 ? (pref32 ? 'AnyCPU (32-bit preferred)' : 'AnyCPU') : MACHINES[machine] ?? 'unknown';

  // Entry point token (Main) unless the entry point is native code.
  const isApp = !(flags & 0x10) && r.u32(cor + 20) !== 0;
  const info: DotnetInfo = { isApp, runtime: md.version, platform, references: [], types: [] };
  if (md.rows[0x20] && md.tableOff[0x20] !== undefined) {
    const v = [1, 2, 3, 4].map((c) => cell(md, 0x20, 1, c)).join('.');
    info.assembly = { name: str(md, cell(md, 0x20, 1, 7)), version: v, culture: str(md, cell(md, 0x20, 1, 8)) || 'neutral' };
  }
  if (md.tableOff[0x23] !== undefined) {
    for (let i = 1; i <= md.rows[0x23]; i++) {
      info.references.push({ name: str(md, cell(md, 0x23, i, 6)), version: [0, 1, 2, 3].map((c) => cell(md, 0x23, i, c)).join('.') });
    }
    info.references.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (md.tableOff[0x02] !== undefined && md.tableOff[0x06] !== undefined) {
    const nTypes = md.rows[0x02];
    const nMethods = md.rows[0x06];
    // Nested types: NestedClass table maps a type to its enclosing type.
    const enclosing = new Map<number, number>();
    if (md.tableOff[0x29] !== undefined) {
      for (let i = 1; i <= md.rows[0x29]; i++) enclosing.set(cell(md, 0x29, i, 0), cell(md, 0x29, i, 1));
    }
    const chain = (row: number): number[] => {
      const out = [row];
      for (let p = enclosing.get(row), guard = 0; p && guard < 32; p = enclosing.get(p), guard++) out.unshift(p);
      return out;
    };
    for (let i = 1; i <= nTypes && info.types.length < 5000; i++) {
      const rowsChain = chain(i);
      const names = rowsChain.map((row) => str(md, cell(md, 0x02, row, 1)));
      if (names.some((n) => n === '<Module>' || n.startsWith('<'))) continue; // compiler-generated
      const name = names.join('.');
      const ns = str(md, cell(md, 0x02, rowsChain[0], 2));
      const prefix = ns ? `${ns}.` : '';
      const visibility = cell(md, 0x02, i, 0) & 7;
      const first = cell(md, 0x02, i, 5);
      const last = i < nTypes ? cell(md, 0x02, i + 1, 5) : nMethods + 1;
      const methods: string[] = [];
      for (let m = first; m < last && m <= nMethods && methods.length < 300; m++) {
        const mName = str(md, cell(md, 0x06, m, 3));
        if (mName.startsWith('<')) continue;
        const isPublic = (cell(md, 0x06, m, 2) & 7) === 6;
        methods.push(isPublic ? mName : `${mName} ·`);
      }
      info.types.push({
        ns,
        name,
        fullName: prefix + names.join('+'),
        outer: prefix + names[0],
        isPublic: visibility === 1 || visibility === 2,
        methods,
      });
    }
  }
  return info;
}

/** ".NETFramework,Version=v4.7.2" (from the TargetFramework attribute) → ".NET Framework 4.7.2". */
function targetFramework(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('latin1').decode(bytes);
  const m = text.match(/\.(NETFramework|NETCoreApp|NETStandard|NETPortable),Version=v([\d.]+)/);
  if (!m) return undefined;
  const [, kind, ver] = m;
  if (kind === 'NETFramework') return `.NET Framework ${ver}`;
  if (kind === 'NETStandard') return `.NET Standard ${ver}`;
  if (kind === 'NETCoreApp') return Number(ver.split('.')[0]) >= 5 ? `.NET ${ver}` : `.NET Core ${ver}`;
  return `.NET Portable ${ver}`;
}

// ---------- PDB ----------

const MSF = 'Microsoft C/C++ MSF 7.00';

export function isPdb(b: Uint8Array): boolean {
  return (b[0] === 0x42 && b[1] === 0x53 && b[2] === 0x4a && b[3] === 0x42) || String.fromCharCode(...b.subarray(0, MSF.length)) === MSF;
}

export function parsePdb(bytes: Uint8Array): PdbInfo {
  const r = new Reader(bytes);
  if (r.u32(0) === 0x424a5342) {
    const info: PdbInfo = { format: 'portable', sources: [] };
    try {
      // #Pdb stream: 20-byte id, entry point, referenced type-system table mask + row counts.
      let md = readMetadata(r, 0);
      const pdb = md.streams['#Pdb'];
      if (pdb) {
        info.id = Array.from(bytes.subarray(pdb.off, pdb.off + 16), (x) => x.toString(16).padStart(2, '0')).join('');
        const lo = r.u32(pdb.off + 24);
        const hi = r.u32(pdb.off + 28);
        const extra: number[] = [];
        let q = pdb.off + 32;
        for (let i = 0; i < 64; i++) {
          if (i < 32 ? lo & (1 << i) : hi & (1 << (i - 32))) {
            extra[i] = r.u32(q);
            q += 4;
          }
        }
        md = readMetadata(r, 0, extra);
      }
      if (md.tableOff[0x30] !== undefined) {
        for (let i = 1; i <= md.rows[0x30] && info.sources.length < 5000; i++) info.sources.push(documentName(md, cell(md, 0x30, i, 0)));
      }
    } catch {
      // fall back to scanning below
    }
    if (!info.sources.length) info.sources = scanSourcePaths(bytes);
    return info;
  }
  return { format: 'windows', sources: scanSourcePaths(bytes) };
}

/** Portable PDB document names are stored as separator + list of blob parts. */
function documentName(md: Metadata, blobIndex: number): string {
  const b = blob(md, blobIndex);
  if (!b.length) return '';
  const sep = String.fromCharCode(b[0]);
  const parts: string[] = [];
  let p = 1;
  while (p < b.length) {
    let v: number;
    const b0 = b[p];
    if (!(b0 & 0x80)) [v, p] = [b0, p + 1];
    else if ((b0 & 0xc0) === 0x80) [v, p] = [((b0 & 0x3f) << 8) | b[p + 1], p + 2];
    else [v, p] = [((b0 & 0x1f) << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3], p + 4];
    parts.push(v ? new TextDecoder().decode(blob(md, v)) : '');
  }
  return parts.join(b[0] ? sep : '');
}

/** Source file paths found in the file (Windows PDBs keep them as plain strings). */
function scanSourcePaths(bytes: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const found = new Set<string>();
  const re = /(?:[A-Za-z]:\\|\/)[^\0\r\n"<>|*?]{2,260}?\.(?:cs|vb|fs|cpp|cxx|cc|c|h|hpp|xaml|razor|cshtml|ts|js)(?![\w.])/g;
  for (const m of text.matchAll(re)) {
    found.add(m[0]);
    if (found.size >= 5000) break;
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}
