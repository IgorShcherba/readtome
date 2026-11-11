// Read To Me's data: the library, the OpenAI key (Keychain only), turning a link or a PDF
// into text, and turning that text into audio, one part at a time.
import type { Answer, Result, Sources, Storage, Store } from './app.contract.d.ts';

const KEY = 'openai.key';
const LIBRARY = 'app:/data/library.json';
const TEXT_DIR = 'app:/data/text';
const AUDIO_DIR = 'app:/data/audio';
const OPENAI = 'https://api.openai.com/v1';
const TTS_MODEL = 'gpt-4o-mini-tts';
const PDF_MODEL = 'gpt-4.1-mini';
// One speech request's input. gpt-4o-mini-tts takes up to 2000 tokens; this stays well under.
const PART_CHARS = 3000;

export const grants = [
  'net.fetch https:',
  `secret.keep ${KEY}`,
  'fs.read app:/data',
  'fs.write app:/data',
  'fs.read app:/tmp/picked',
].join('\n');

type Item = Result<'loadItems'>[number];
type Reply = Result<'addLink'>;
type Library = { next: number; items: Item[] };

const ok = (id = ''): Reply => ({ ok: true, error: '', id });
const refuse = (error: string): Reply => ({ ok: false, error, id: '' });

// --- the library: one JSON file of items; each item's text in its own file ---

const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

async function readLibrary(storage: Storage): Promise<Library> {
  try {
    return JSON.parse(decode(await storage.fs.readFile(LIBRARY)));
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'bake') return { next: 1, items: [] };
    throw e;
  }
}
// A folder made once; one that is already there is fine.
async function folder(storage: Storage, path: string) {
  try { await storage.fs.mkdir(path); } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
}

const writeLibrary = (storage: Storage, lib: Library) =>
  storage.fs.atomicWriteFile(LIBRARY, encode(JSON.stringify(lib)));

async function readParts(storage: Storage, id: string): Promise<string[]> {
  return JSON.parse(decode(await storage.fs.readFile(`${TEXT_DIR}/${id}.json`)));
}

async function addItem(storage: Storage, title: string, source: string, kind: string, text: string): Promise<Reply> {
  const parts = split(text);
  if (parts.length === 0) return refuse('No readable text was found.');
  const lib = await readLibrary(storage);
  const id = String(lib.next);
  await folder(storage, TEXT_DIR);
  await storage.fs.atomicWriteFile(`${TEXT_DIR}/${id}.json`, encode(JSON.stringify(parts)));
  const item: Item = {
    id, title: title || 'Untitled', source, kind, voice: '', error: '',
    words: text.split(/\s+/).filter(Boolean).length,
    parts: parts.map((p, index) => ({ index, path: '', chars: p.length })),
  };
  await writeLibrary(storage, { next: lib.next + 1, items: [item, ...lib.items] });
  return ok(id);
}

// --- text: split into parts at paragraph, then sentence, then word boundaries ---

function split(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  const push = () => { if (current.trim()) parts.push(current.trim()); current = ''; };
  const pieces = text.split(/\n{2,}/).flatMap((para) =>
    para.length <= PART_CHARS ? [para] : para.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) ?? [para]);
  for (let piece of pieces) {
    while (piece.length > PART_CHARS) {
      const cut = piece.lastIndexOf(' ', PART_CHARS);
      const at = cut > 0 ? cut : PART_CHARS;
      push(); parts.push(piece.slice(0, at).trim()); piece = piece.slice(at);
    }
    if (current.length + piece.length + 2 > PART_CHARS) push();
    current += (current ? '\n\n' : '') + piece.trim();
  }
  push();
  return parts;
}

// --- a link: fetch the page and keep its article's text ---

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const entities = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

function meta(html: string, name: string): string {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'))?.[0];
  return entities(tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? '').trim();
}

export function extract(html: string): { title: string; text: string } {
  const title = meta(html, 'og:title')
    || entities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  let body = html.replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|figure)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.match(/<article\b[\s\S]*<\/article>/i)?.[0]
    ?? body.match(/<main\b[\s\S]*<\/main>/i)?.[0]
    ?? body.match(/<body\b[\s\S]*<\/body>/i)?.[0]
    ?? body;
  const text = entities(body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr|pre)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .split(/\n/)
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    // Menus, share buttons and bylines are short and end without a full stop.
    .filter((p) => p.length >= 60 || /[.!?:"”]$/.test(p))
    .join('\n\n');
  return { title, text };
}

async function addLink(storage: Storage, raw: string): Promise<Reply> {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return refuse('That doesn’t look like a web address.'); }
  if (url.protocol !== 'https:') return refuse('Only https:// links can be read.');
  let response: Response;
  try {
    response = await fetch(url.href, { exactTimeout: 30000, headers: { Accept: 'text/html' } });
  } catch {
    return refuse('Couldn’t reach that page. Check the link and your connection.');
  }
  if (!response.ok) return refuse(`The page answered ${response.status}.`);
  const { title, text } = extract(await response.text());
  if (text.length < 200) return refuse('Couldn’t find an article on that page.');
  return addItem(storage, title || url.hostname, url.href, 'link', text);
}

// --- a PDF: OpenAI reads it and returns its text ---

async function base64(bytes: Uint8Array): Promise<string> {
  // In slices, yielding between them: each turn of an answer has a CPU budget.
  let out = '';
  for (let i = 0; i < bytes.length; i += 96 * 1024) {
    let s = '';
    const slice = bytes.subarray(i, i + 96 * 1024);
    for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j]);
    out += btoa(s);
    await scheduler.yield();
  }
  return out;
}

const PDF_PROMPT = `Extract this document's readable text for listening as an audiobook.
On the first line write "TITLE: " and the document's title.
Then a blank line, then the full body text in reading order, in plain paragraphs separated by blank lines.
Leave out page numbers, running headers and footers, figure and table contents, footnote markers and references.
Do not summarize or shorten; keep every sentence of the body.`;

async function openai(store: Store, path: string, body: unknown, timeout: number): Promise<Response> {
  const key = store.get(KEY);
  if (!key) throw new Refusal('Add your OpenAI key in Settings first.');
  let response: Response;
  try {
    response = await fetch(`${OPENAI}${path}`, {
      method: 'POST', exactTimeout: timeout,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Refusal('Couldn’t reach OpenAI. Check your connection.');
  }
  if (response.ok) return response;
  if (response.status === 401) throw new Refusal('OpenAI didn’t accept the key. Check it in Settings.');
  if (response.status === 429) throw new Refusal('OpenAI says you’re over your limit or out of credit.');
  let message = '';
  try { message = (await response.json())?.error?.message ?? ''; } catch {}
  throw new Refusal(`OpenAI answered ${response.status}${message ? `: ${message}` : '.'}`);
}

class Refusal extends Error {}

async function addPdf(storage: Storage, store: Store, path: string, name: string): Promise<Reply> {
  if (!path.startsWith('app:/tmp/picked/')) return refuse('Choose a PDF to add.');
  const bytes = new Uint8Array(await storage.fs.readFile(path));
  if (bytes.length > 30 * 1024 * 1024) return refuse('That PDF is larger than 30 MB.');
  const response = await openai(store, '/responses', {
    model: PDF_MODEL,
    max_output_tokens: 32000,
    input: [{
      role: 'user',
      content: [
        { type: 'input_file', filename: name || 'document.pdf', file_data: `data:application/pdf;base64,${await base64(bytes)}` },
        { type: 'input_text', text: PDF_PROMPT },
      ],
    }],
  }, 600000);
  const json: any = await response.json();
  const out = (json.output ?? []).flatMap((o: any) => o.content ?? [])
    .filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
  const match = out.match(/^\s*TITLE:\s*(.*)\n/);
  const title = match?.[1]?.trim() || name.replace(/\.pdf$/i, '');
  return addItem(storage, title, name, 'pdf', match ? out.slice(match[0].length).trim() : out.trim());
}

// --- speech: the next part without audio, with the chosen voice ---

async function generateNext(storage: Storage, store: Store, id: string, voice: string): Promise<Result<'generateNext'>> {
  const lib = await readLibrary(storage);
  const item = lib.items.find((i) => i.id === id);
  if (!item) return { ok: false, error: 'That item was deleted.', more: false };
  // A new voice starts the audio over.
  if (item.voice !== voice) {
    item.parts = item.parts.map((p) => ({ ...p, path: '' }));
    item.voice = voice;
  }
  const part = item.parts.find((p) => p.path === '');
  if (!part) return { ok: true, error: '', more: false };
  const text = (await readParts(storage, id))[part.index];
  try {
    const response = await openai(store, '/audio/speech', {
      model: TTS_MODEL, voice, input: text, response_format: 'mp3',
      instructions: 'Read like a warm, clear audiobook narrator, at a natural pace.',
    }, 300000);
    await folder(storage, AUDIO_DIR);
    await folder(storage, `${AUDIO_DIR}/${id}`);
    const file = `${AUDIO_DIR}/${id}/${voice}-${part.index}.mp3`;
    await storage.fs.atomicWriteFile(file, new Uint8Array(await response.arrayBuffer()));
    part.path = file;
    item.error = '';
  } catch (e) {
    item.error = e instanceof Refusal ? e.message : 'Something went wrong making the audio.';
  }
  // Read again: the item may have been deleted while the audio was made.
  const now = await readLibrary(storage);
  if (!now.items.some((i) => i.id === id)) return { ok: false, error: 'That item was deleted.', more: false };
  await writeLibrary(storage, { ...now, items: now.items.map((i) => (i.id === id ? item : i)) });
  if (item.error) return { ok: false, error: item.error, more: false };
  return { ok: true, error: '', more: item.parts.some((p) => p.path === '') };
}

async function removeItem(storage: Storage, id: string): Promise<Reply> {
  const lib = await readLibrary(storage);
  const item = lib.items.find((i) => i.id === id);
  await writeLibrary(storage, { ...lib, items: lib.items.filter((i) => i.id !== id) });
  // The files go after the item, so a failed delete never leaves an item without them.
  for (const p of item?.parts ?? []) if (p.path) await storage.fs.rm(p.path).catch(() => {});
  await storage.fs.rm(`${TEXT_DIR}/${id}.json`).catch(() => {});
  return ok();
}

const masked = (key: string) => (key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '…');

const refusing = async (work: () => Promise<Reply>): Promise<Reply> => {
  try { return await work(); } catch (e) { if (e instanceof Refusal) return refuse(e.message); throw e; }
};

const sources: Sources = {
  loadItems: async (_args, _store, storage) => (await readLibrary(storage)).items,
  keyStatus: (_args, store) => {
    const key = store.get(KEY);
    return { saved: !!key, hint: key ? masked(key) : '' };
  },
  saveKey: ([key], store) => {
    const k = key.trim();
    if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(k)) return refuse('That doesn’t look like an OpenAI key (it starts with “sk-”).');
    store.set(KEY, k);
    return ok();
  },
  forgetKey: (_args, store) => { store.forget(KEY); return ok(); },
  addLink: ([url], _store, storage) => refusing(() => addLink(storage, url.trim())),
  addPdf: ([path, name], store, storage) => refusing(() => addPdf(storage, store, path, name)),
  generateNext: ([id, voice], store, storage) => generateNext(storage, store, id, voice),
  removeItem: ([id], _store, storage) => removeItem(storage, id),
};

export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
