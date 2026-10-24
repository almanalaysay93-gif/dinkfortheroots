// Tests for apps-script/Code.gs. The real script runs in a Node vm context
// against in-memory fakes of the Apps Script services it uses.
// Run: node --test tests/code.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const SHEET = 'Registrations';
const ADMIN_KEY = 'test-admin-key';
const REF_PATTERN = /^DFR-[A-HJ-NP-Z2-9]{6}$/;
const CUTOFF_ISO = '2026-11-20T23:59:59+08:00';
const DEFAULT_ORGANIZERS = ['ibanezdianarose9@gmail.com', 'aceyorkbasilan@gmail.com'];

// Written out here on purpose, separate from Code.gs, so a header change is caught.
const EXPECTED_HEADERS = [
  'Ref', 'Submitted At', 'Status', 'Full Name', 'Email', 'Phone', 'Municipality',
  'Barangay', 'Category', 'Partner Name', 'Club Name', 'Shirt Size', 'Payment Ref (player)',
  'Receipt File ID', 'Receipt URL', 'Valid ID File ID', 'Valid ID URL', 'Verdict', 'OCR Amount',
  'OCR Reference No', 'OCR Txn Date', 'OCR Sender', 'OCR Recipient', 'Tamper Score', 'Flags',
  'Image Hash', 'Checked At', 'OCR Text', 'Player Email Sent', 'Organizer Email Sent'
];

// The header before CR1 (27 columns), used to test the setup migration.
const OLD_HEADERS = [
  'Ref', 'Submitted At', 'Status', 'Full Name', 'Email', 'Phone', 'Municipality',
  'Barangay', 'Category', 'Partner Name', 'Shirt Size', 'Payment Ref (player)',
  'Receipt File ID', 'Receipt URL', 'Verdict', 'OCR Amount', 'OCR Reference No',
  'OCR Txn Date', 'OCR Sender', 'OCR Recipient', 'Tamper Score', 'Flags',
  'Image Hash', 'Checked At', 'OCR Text', 'Player Email Sent', 'Organizer Email Sent'
];

const PAIR_HEADERS = [
  'Pair No', 'Pair Status', 'Player 1', 'P1 Ref', 'P1 Status', 'P1 Club', 'P1 Phone', 'P1 Email', 'P1 Shirt',
  'Player 2', 'P2 Ref', 'P2 Status', 'P2 Club', 'P2 Phone', 'P2 Email', 'P2 Shirt', 'Note'
];

const LABEL = {
  'novice-mens': "Novice Men's Doubles",
  'novice-womens': "Novice Women's Doubles",
  'novice-mixed': 'Novice Mixed Doubles',
  'rookie-mens': "Rookie Men's Doubles",
  'rookie-womens': "Rookie Women's Doubles",
  'rookie-mixed': 'Rookie Mixed Doubles'
};

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeSheet(initialRows) {
  const rows = initialRows.map((r) => r.slice());
  return {
    rows,
    frozen: 0,
    getLastRow: () => rows.length,
    appendRow(values) {
      rows.push(values.slice());
    },
    clearContents() {
      rows.length = 0;
    },
    setFrozenRows(n) {
      this.frozen = n;
    },
    getRange(row, col, numRows, numCols) {
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const source = rows[row - 1 + r] || [];
            out.push(Array.from({ length: numCols }, (_, c) => source[col - 1 + c] ?? ''));
          }
          return out;
        },
        setValues(values) {
          values.forEach((vals, r) => {
            while (rows.length < row + r) {
              rows.push([]);
            }
            vals.forEach((v, c) => {
              rows[row - 1 + r][col - 1 + c] = v;
            });
          });
        }
      };
    }
  };
}

function iterator(list) {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++] };
}

function makeBlob(bytes, mime, name) {
  const blob = {
    bytes,
    mime,
    name,
    getBytes: () => blob.bytes,
    getName: () => blob.name,
    getContentType: () => blob.mime,
    setName(n) {
      blob.name = n;
      return blob;
    }
  };
  return blob;
}

function makeFolder(name, id, state) {
  return {
    name,
    id,
    getId: () => id,
    createFile(blob) {
      state.fileSeq += 1;
      const fileId = 'file' + state.fileSeq;
      const file = {
        id: fileId,
        blob,
        folderName: name,
        access: null,
        permission: null,
        getId: () => fileId,
        getUrl: () => 'https://drive.example/' + fileId,
        getBlob: () => blob,
        setSharing(access, permission) {
          this.access = access;
          this.permission = permission;
        }
      };
      state.files[fileId] = file;
      return file;
    }
  };
}

function makeEnv(options = {}) {
  const state = {
    props: {
      ADMIN_KEY,
      RECEIPT_FOLDER_ID: 'folder1',
      ORGANIZER_EMAIL: 'org@example.com',
      POSTER_URL: '',
      ...(options.props || {})
    },
    sheets: {},
    folders: [],
    files: {},
    fileSeq: 0,
    mails: [],
    logs: [],
    fetches: [],
    locked: false,
    lockBusy: false,
    mailFailWith: '',
    posterMode: 'ok',
    // Drive OCR fake: 'ok' returns ocrText, 'uploadFail' answers HTTP 500, 'throw' throws.
    ocrMode: 'ok',
    ocrText: 'GoTyme Bank\nAmount ₱1,200.00\nRef No. 1234 567 890123',
    ocrCalls: [],
    ...(options.state || {})
  };
  if (options.withSheet !== false) {
    state.sheets[SHEET] = makeSheet(options.rows || [EXPECTED_HEADERS]);
  }
  if (options.withFolder !== false) {
    state.folders.push(makeFolder('Dink for the Roots Receipts', 'folder1', state));
  }

  const ctx = {
    Logger: { log: (m) => state.logs.push(String(m)) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => state.sheets[name] || null,
        insertSheet: (name) => {
          state.sheets[name] = makeSheet([]);
          return state.sheets[name];
        },
        getUrl: () => 'https://sheet.example/test'
      })
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      Permission: { NONE: 'NONE' },
      getFoldersByName: (name) => iterator(state.folders.filter((f) => f.name === name)),
      createFolder(name) {
        const folder = makeFolder(name, 'folder' + (state.folders.length + 1), state);
        state.folders.push(folder);
        return folder;
      },
      getFolderById(id) {
        const folder = state.folders.find((f) => f.id === id);
        if (!folder) {
          throw new Error('Folder not found: ' + id);
        }
        return folder;
      },
      getFileById(id) {
        const file = state.files[id];
        if (!file) {
          throw new Error('File not found: ' + id);
        }
        return file;
      }
    },
    Utilities: {
      base64Decode(s) {
        if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
          throw new Error('Invalid base64');
        }
        return Array.from(Buffer.from(s, 'base64'));
      },
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      newBlob: (data, mime, name) => makeBlob(
        typeof data === 'string' ? Array.from(Buffer.from(data, 'utf8')) : Array.from(data), mime, name),
      getUuid: () => randomUUID(),
      formatDate: (date) => date.toISOString()
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (state.lockBusy || state.locked) {
            throw new Error('Timed out waiting for lock');
          }
          state.locked = true;
        },
        releaseLock() {
          state.locked = false;
        }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in state.props ? state.props[k] : null),
        setProperty(k, v) {
          state.props[k] = String(v);
        }
      })
    },
    MailApp: {
      sendEmail(options) {
        if (state.mailFailWith) {
          throw new Error(state.mailFailWith);
        }
        state.mails.push({ ...options, lockedAtSend: state.locked });
      }
    },
    ScriptApp: { getOAuthToken: () => 'test-token' },
    UrlFetchApp: {
      fetch(url, opts = {}) {
        if (url.startsWith('https://www.googleapis.com/')) {
          state.ocrCalls.push({ url, method: opts.method || 'get' });
          if (state.ocrMode === 'throw') {
            throw new Error('Drive unavailable');
          }
          if (url.includes('/upload/')) {
            const code = state.ocrMode === 'uploadFail' ? 500 : 200;
            return { getResponseCode: () => code, getContentText: () => JSON.stringify({ id: 'ocr-doc-1' }) };
          }
          if (url.includes('/export')) {
            return { getResponseCode: () => 200, getContentText: () => state.ocrText };
          }
          return { getResponseCode: () => 204, getContentText: () => '' };
        }
        state.fetches.push(url);
        if (state.posterMode === 'throw') {
          throw new Error('fetch failed');
        }
        const status = state.posterMode === 'missing' ? 404 : 200;
        return {
          getResponseCode: () => status,
          getBlob: () => makeBlob(JPEG.slice(), 'image/jpeg', 'poster.jpg')
        };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return {
          setMimeType() {
            return this;
          },
          getContent: () => text
        };
      }
    }
  };

  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  return { ctx, state };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function call(env, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const out = env.ctx.doPost({ postData: { contents: raw } });
  return JSON.parse(out.getContent());
}

function slotsGet(env) {
  return JSON.parse(env.ctx.doGet({ parameter: { action: 'slots' } }).getContent());
}

function setNow(env, iso) {
  env.ctx.now_ = () => new Date(iso);
}

function validPlayer(overrides = {}) {
  return {
    fullName: 'Juan Dela Cruz',
    email: 'Juan@Example.com',
    phone: '0917 123 4567',
    municipality: 'Digos City',
    barangay: 'Zone 1',
    category: 'novice-mens',
    partnerName: 'Pedro Santos',
    shirtSize: 'M',
    paymentRef: 'GC-123456',
    ...overrides
  };
}

function validReceipt(overrides = {}) {
  return {
    fileName: 'gcash.jpg',
    mimeType: 'image/jpeg',
    base64: b64(JPEG),
    ...overrides
  };
}

function validId(overrides = {}) {
  return {
    fileName: 'id.jpg',
    mimeType: 'image/jpeg',
    base64: b64(JPEG),
    ...overrides
  };
}

function registerBody(player = {}, receipt = {}, extra = {}) {
  return {
    action: 'register',
    player: validPlayer(player),
    receipt: validReceipt(receipt),
    validId: validId(),
    consent: true,
    ...extra
  };
}

function register(env, player = {}, receipt = {}, extra = {}) {
  return call(env, registerBody(player, receipt, extra));
}

function dataRows(env) {
  return env.state.sheets[SHEET].rows.slice(1);
}

function cell(row, name) {
  return row[EXPECTED_HEADERS.indexOf(name)];
}

function seedRow(fields) {
  return EXPECTED_HEADERS.map((h) => fields[h] ?? '');
}

function seedRegistrations(count, fields) {
  return Array.from({ length: count }, (_, i) =>
    seedRow({
      Ref: 'SEED' + i,
      Status: 'Pending check',
      Email: 'seed' + i + '@example.com',
      Category: LABEL['novice-mens'],
      ...fields
    })
  );
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function mailTo(env, address) {
  return env.state.mails.find((m) => m.to === address);
}

function organizerMail(env) {
  return env.state.mails.find((m) => m.subject.startsWith('New registration'));
}

// A row object keyed by header name, for the pure pairing function.
function pRow(fields) {
  const row = {};
  EXPECTED_HEADERS.forEach((h) => {
    row[h] = '';
  });
  return Object.assign(row, {
    Status: 'Pending check',
    Category: LABEL['novice-mens'],
    Phone: "'+639171234567",
    'Shirt Size': 'M'
  }, fields);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('setup creates the header in contract order, the tabs, and both folders', () => {
  const env = makeEnv({ withSheet: false, withFolder: false });
  for (const key of ['ADMIN_KEY', 'ORGANIZER_EMAIL', 'POSTER_URL', 'RECEIPT_FOLDER_ID']) {
    delete env.state.props[key];
  }

  env.ctx.setup();

  const sheet = env.state.sheets[SHEET];
  assert.deepEqual(plain(sheet.rows[0]), EXPECTED_HEADERS);
  assert.equal(sheet.frozen, 1);
  assert.deepEqual(env.state.folders.map((f) => f.name), [
    'Dink for the Roots Receipts',
    'Dink for the Roots Valid IDs'
  ]);
  assert.equal(env.state.props.RECEIPT_FOLDER_ID, env.state.folders[0].id);
  assert.equal(env.state.props.VALID_ID_FOLDER_ID, env.state.folders[1].id);
  assert.equal(env.state.props.ORGANIZER_EMAIL, DEFAULT_ORGANIZERS.join(', '));
  assert.equal(env.state.props.POSTER_URL, '');
  assert.match(env.state.props.ADMIN_KEY, /^[0-9a-f-]{36}$/);
  assert.ok(env.state.logs.some((l) => l.includes(env.state.props.ADMIN_KEY)));
  assert.ok(env.state.sheets["Novice Men's"], 'category tab created');
  assert.ok(env.state.sheets['Rookie Mixed'], 'category tab created');
});

test('setup keeps an existing admin key and reuses both folders', () => {
  const env = makeEnv();
  env.ctx.setup();
  env.ctx.setup();
  assert.equal(env.state.props.ADMIN_KEY, ADMIN_KEY);
  assert.equal(env.state.folders.length, 2);
});

test('setup writes the new header over an old header when the sheet has no data rows', () => {
  const env = makeEnv({ rows: [OLD_HEADERS] });
  env.ctx.setup();
  assert.deepEqual(plain(env.state.sheets[SHEET].rows[0]), EXPECTED_HEADERS);
});

test('setup refuses a sheet whose header row differs from the contract when data rows exist', () => {
  const env = makeEnv({ rows: [OLD_HEADERS, seedRow({ Ref: 'SEED0' })] });
  assert.throws(() => env.ctx.setup(), /does not match the contract header/);
});

// ---------------------------------------------------------------------------
// Slots and cut-off
// ---------------------------------------------------------------------------

test('slots returns zero counts for an empty sheet with cap 40', () => {
  const env = makeEnv();
  const res = slotsGet(env);
  assert.equal(res.ok, true);
  assert.equal(res.open, true);
  assert.equal(res.closesAt, CUTOFF_ISO);
  for (const key of Object.keys(LABEL)) {
    assert.deepEqual(res.slots[key], { taken: 0, cap: 40 });
  }
});

test('slots via POST returns the same result as GET', () => {
  const env = makeEnv();
  assert.deepEqual(call(env, { action: 'slots' }), slotsGet(env));
});

test('slots counts rows that are not Rejected', () => {
  const env = makeEnv({
    rows: [
      EXPECTED_HEADERS,
      ...seedRegistrations(2, {}),
      ...seedRegistrations(1, { Status: 'Rejected' }),
      ...seedRegistrations(1, { Category: LABEL['rookie-mens'] })
    ]
  });
  const res = slotsGet(env);
  assert.equal(res.slots['novice-mens'].taken, 2);
  assert.equal(res.slots['rookie-mens'].taken, 1);
});

test('slots reports open at the cut-off second', () => {
  const env = makeEnv();
  setNow(env, '2026-11-20T23:59:59.000+08:00');
  assert.equal(slotsGet(env).open, true);
});

test('slots reports open false and closesAt after the cut-off', () => {
  const env = makeEnv();
  setNow(env, '2026-11-21T00:00:00+08:00');
  const res = slotsGet(env);
  assert.equal(res.ok, true);
  assert.equal(res.open, false);
  assert.equal(res.closesAt, CUTOFF_ISO);
});

test('register is open at exactly the cut-off second', () => {
  const env = makeEnv();
  setNow(env, '2026-11-20T23:59:59.000+08:00');
  assert.equal(register(env).ok, true);
});

test('register returns CLOSED one millisecond after the cut-off', () => {
  const env = makeEnv();
  setNow(env, '2026-11-20T23:59:59.001+08:00');
  const res = register(env);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'CLOSED');
  assert.equal(res.message, 'Registration closed on November 20, 2026 at 11:59 PM.');
});

test('register returns CLOSED before consent and field validation run', () => {
  const env = makeEnv();
  setNow(env, '2026-11-21T00:00:00+08:00');
  const res = call(env, { action: 'register', player: { email: 'not-an-email' }, receipt: {}, consent: false });
  assert.equal(res.error, 'CLOSED');
  assert.equal(dataRows(env).length, 0);
  assert.equal(env.state.mails.length, 0);
  assert.equal(Object.keys(env.state.files).length, 0);
});

// ---------------------------------------------------------------------------
// Register: happy path
// ---------------------------------------------------------------------------

test('register happy path stores a pending row and sends two emails', () => {
  const env = makeEnv({ props: { POSTER_URL: 'https://posters.example/poster.jpg' } });
  const res = register(env);

  assert.equal(res.ok, true);
  assert.match(res.ref, REF_PATTERN);

  const rows = dataRows(env);
  assert.equal(rows.length, 1);
  assert.equal(cell(rows[0], 'Ref'), res.ref);
  assert.equal(cell(rows[0], 'Status'), 'Pending check');
  assert.equal(cell(rows[0], 'Email'), 'juan@example.com');
  assert.equal(cell(rows[0], 'Phone'), "'+639171234567");
  assert.equal(cell(rows[0], 'Category'), "Novice Men's Doubles");
  assert.equal(cell(rows[0], 'Player Email Sent'), 'yes');
  assert.equal(cell(rows[0], 'Organizer Email Sent'), 'yes');
  assert.equal(cell(rows[0], 'Receipt URL'), 'https://drive.example/file1');

  const file = env.state.files.file1;
  assert.equal(file.blob.name, res.ref + '-gcash.jpg');
  assert.equal(file.blob.mime, 'image/jpeg');
  assert.equal(file.access, 'PRIVATE');
  assert.equal(file.permission, 'NONE');

  assert.equal(env.state.mails.length, 2);
  const playerMail = mailTo(env, 'juan@example.com');
  const orgMail = organizerMail(env);
  assert.ok(playerMail, 'player mail sent');
  assert.ok(orgMail, 'organizer mail sent');
  assert.equal(playerMail.name, 'Dink for the Roots');
  assert.equal(playerMail.attachments.length, 1);
  assert.equal(playerMail.attachments[0].name, 'Dink-for-the-Roots-poster.jpg');
  assert.ok(playerMail.body.includes(res.ref));
  assert.ok(playerMail.body.includes('Saturday, December 5, 2026'));
  assert.ok(playerMail.body.includes('Pickle Park, Roxas Extension, Digos City'));
  assert.ok(playerMail.htmlBody.includes(res.ref));
  assert.ok(orgMail.body.includes('https://drive.example/file1'));
  assert.ok(orgMail.body.includes('https://sheet.example/test'));
  assert.equal(env.state.fetches[0], 'https://posters.example/poster.jpg');
});

test('emails are sent after the lock is released', () => {
  const env = makeEnv();
  register(env);
  assert.equal(env.state.mails.length, 2);
  assert.ok(env.state.mails.every((m) => m.lockedAtSend === false));
  assert.equal(env.state.locked, false);
});

test('register sends no attachment when POSTER_URL is empty', () => {
  const env = makeEnv();
  const res = register(env);
  assert.equal(res.ok, true);
  assert.equal(env.state.fetches.length, 0);
  assert.equal(mailTo(env, 'juan@example.com').attachments, undefined);
});

test('register succeeds without the poster when the poster fetch fails', () => {
  const env = makeEnv({ props: { POSTER_URL: 'https://posters.example/poster.jpg' } });
  env.state.posterMode = 'throw';
  const res = register(env);
  assert.equal(res.ok, true);
  assert.equal(cell(dataRows(env)[0], 'Player Email Sent'), 'yes');
  assert.equal(mailTo(env, 'juan@example.com').attachments, undefined);
});

test('register succeeds without the poster when the poster returns HTTP 404', () => {
  const env = makeEnv({ props: { POSTER_URL: 'https://posters.example/missing.jpg' } });
  env.state.posterMode = 'missing';
  const res = register(env);
  assert.equal(res.ok, true);
  assert.equal(mailTo(env, 'juan@example.com').attachments, undefined);
});

test('register accepts PNG and WebP receipts that match their signatures', () => {
  const png = makeEnv();
  assert.equal(register(png, {}, { mimeType: 'image/png', base64: b64(PNG), fileName: 'r.png' }).ok, true);
  const webp = makeEnv();
  assert.equal(register(webp, {}, { mimeType: 'image/webp', base64: b64(WEBP), fileName: 'r.webp' }).ok, true);
});

test('register normalizes the phone number to +639 form', () => {
  const env = makeEnv();
  const res = register(env, { phone: '+63 917-123-4567' });
  assert.equal(res.ok, true);
  assert.equal(cell(dataRows(env)[0], 'Phone'), "'+639171234567");
});

// ---------------------------------------------------------------------------
// Club name
// ---------------------------------------------------------------------------

test('club name is optional: blank is accepted and stored empty', () => {
  const env = makeEnv();
  const res = register(env, { clubName: '   ' });
  assert.equal(res.ok, true);
  assert.equal(cell(dataRows(env)[0], 'Club Name'), '');
  assert.equal(mailTo(env, 'juan@example.com').body.includes('Club:'), false);
});

test('club name of exactly 100 characters is accepted', () => {
  const env = makeEnv();
  const res = register(env, { clubName: 'a'.repeat(100) });
  assert.equal(res.ok, true);
  assert.equal(cell(dataRows(env)[0], 'Club Name'), 'a'.repeat(100));
});

test('club name shows in the player and organizer emails when set', () => {
  const env = makeEnv();
  register(env, { clubName: 'Digos Dinkers' });
  assert.ok(mailTo(env, 'juan@example.com').body.includes('Club: Digos Dinkers'));
  assert.ok(organizerMail(env).body.includes('Club: Digos Dinkers'));
});

// ---------------------------------------------------------------------------
// Register: validation
// ---------------------------------------------------------------------------

const VALIDATION_CASES = [
  ['bad email', { email: 'juan@' }, {}, {}, 'email'],
  ['bad phone', { phone: '12345' }, {}, {}, 'phone'],
  ['phone with wrong prefix', { phone: '0817 123 4567' }, {}, {}, 'phone'],
  ['municipality outside list', { municipality: 'Davao City' }, {}, {}, 'municipality'],
  ['bad shirt size', { shirtSize: 'XXL' }, {}, {}, 'shirtSize'],
  ['bad category', { category: 'open' }, {}, {}, 'category'],
  ['retired rookie category', { category: 'rookie' }, {}, {}, 'category'],
  ['club name 101 characters', { clubName: 'a'.repeat(101) }, {}, {}, 'clubName'],
  ['oversize receipt', {}, { base64: b64([...JPEG, ...Array(5 * 1024 * 1024).fill(0)]) }, {}, 'receipt.base64'],
  ['wrong receipt mime type', {}, { mimeType: 'application/pdf' }, {}, 'receipt.mimeType'],
  ['receipt mime does not match bytes', {}, { mimeType: 'image/png' }, {}, 'receipt.mimeType'],
  ['no consent', {}, {}, { consent: false }, 'consent'],
  ['invalid receipt base64', {}, { base64: 'not base64!' }, {}, 'receipt.base64'],
  ['partner same as player', { partnerName: 'juan dela cruz' }, {}, {}, 'partnerName'],
  ['valid ID missing', {}, {}, { validId: undefined }, 'validId.base64'],
  ['valid ID wrong mime type', {}, {}, { validId: validId({ mimeType: 'application/pdf' }) }, 'validId.mimeType'],
  ['valid ID mime does not match bytes', {}, {}, { validId: validId({ mimeType: 'image/webp' }) }, 'validId.mimeType'],
  ['valid ID invalid base64', {}, {}, { validId: validId({ base64: 'bad!' }) }, 'validId.base64']
];

for (const [name, player, receipt, extra, field] of VALIDATION_CASES) {
  test('register rejects ' + name, () => {
    const env = makeEnv();
    const res = register(env, player, receipt, extra);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'INVALID');
    assert.equal(res.field, field);
    assert.equal(dataRows(env).length, 0, 'no row written');
    assert.equal(env.state.mails.length, 0, 'no email sent');
    assert.equal(Object.keys(env.state.files).length, 0, 'no file saved');
  });
}

test('valid ID error messages name the valid ID, not the receipt', () => {
  const env = makeEnv();
  const res = register(env, {}, {}, { validId: validId({ mimeType: 'application/pdf' }) });
  assert.equal(res.message, 'Valid ID must be a JPEG, PNG, or WebP image.');
});

test('receipt error messages are unchanged', () => {
  const env = makeEnv();
  const res = register(env, {}, { mimeType: 'application/pdf' });
  assert.equal(res.message, 'Receipt must be a JPEG, PNG, or WebP image.');
});

test('register rejects a request body that is not JSON', () => {
  const env = makeEnv();
  const res = call(env, '{not json');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'BAD_JSON');
});

test('register rejects an unknown action', () => {
  const env = makeEnv();
  assert.equal(call(env, { action: 'nope' }).error, 'BAD_ACTION');
  assert.equal(slotsGet(env).ok, true);
  assert.equal(env.ctx.doGet({ parameter: { action: 'other' } }).getContent().includes('BAD_ACTION'), true);
});

test('slots returns NOT_SETUP when the sheet is missing', () => {
  const env = makeEnv({ withSheet: false });
  const res = call(env, { action: 'slots' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NOT_SETUP');
});

test('register returns SERVER when the receipt folder is missing', () => {
  const env = makeEnv({ withFolder: false });
  const res = register(env);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'SERVER');
  assert.equal(res.message, 'Server error. Please try again later.');
  assert.equal(dataRows(env).length, 0);
});

// ---------------------------------------------------------------------------
// Valid ID
// ---------------------------------------------------------------------------

test('valid ID is saved private in the ID folder with its columns filled', () => {
  const env = makeEnv();
  const res = register(env);
  const row = dataRows(env)[0];

  const idFile = env.state.files.file2;
  assert.equal(idFile.folderName, 'Dink for the Roots Valid IDs');
  assert.equal(idFile.blob.name, res.ref + '-ID-id.jpg');
  assert.equal(idFile.access, 'PRIVATE');
  assert.equal(idFile.permission, 'NONE');
  assert.equal(env.state.props.VALID_ID_FOLDER_ID, env.state.folders[1].id);
  assert.equal(cell(row, 'Valid ID File ID'), 'file2');
  assert.equal(cell(row, 'Valid ID URL'), 'https://drive.example/file2');
  assert.equal(cell(row, 'Receipt File ID'), 'file1');
});

test('organizer email has a Valid ID link row', () => {
  const env = makeEnv();
  register(env);
  assert.ok(organizerMail(env).body.includes('Valid ID: https://drive.example/file2'));
});

test('organizer email goes to both default addresses and the property address once', () => {
  const env = makeEnv({ props: { ORGANIZER_EMAIL: 'org@example.com, IBANEZDIANAROSE9@gmail.com, ' } });
  register(env);
  const to = organizerMail(env).to.split(',').map((s) => s.trim());
  assert.deepEqual([...to].sort(), [...DEFAULT_ORGANIZERS, 'org@example.com'].sort());
  assert.equal(new Set(to).size, to.length, 'no duplicates');
});

test('organizer email still reaches both defaults when ORGANIZER_EMAIL is empty', () => {
  const env = makeEnv({ props: { ORGANIZER_EMAIL: '' } });
  register(env);
  const to = organizerMail(env).to.split(',').map((s) => s.trim());
  assert.deepEqual(to, DEFAULT_ORGANIZERS);
});

// ---------------------------------------------------------------------------
// Register: duplicates, cap, locking
// ---------------------------------------------------------------------------

test('same email in the same category returns the existing ref', () => {
  const env = makeEnv();
  const first = register(env);
  const mailsAfterFirst = env.state.mails.length;

  const second = register(env, { email: 'JUAN@example.com ' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.ref, first.ref);
  assert.equal(dataRows(env).length, 1);
  assert.equal(env.state.mails.length, mailsAfterFirst);
});

test('same email in a different category is a new registration', () => {
  const env = makeEnv();
  const first = register(env);
  const second = register(env, { category: 'rookie-mens' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, undefined);
  assert.notEqual(second.ref, first.ref);
  assert.equal(dataRows(env).length, 2);
});

test('a Rejected registration does not block the same email from registering again', () => {
  const env = makeEnv({
    rows: [EXPECTED_HEADERS, seedRow({ Ref: 'DFR-OLDAAA', Status: 'Rejected', Email: 'juan@example.com', Category: LABEL['novice-mens'] })]
  });
  const res = register(env);
  assert.equal(res.ok, true);
  assert.equal(res.duplicate, undefined);
  assert.notEqual(res.ref, 'DFR-OLDAAA');
});

test('register returns FULL when 40 rows of the category are taken', () => {
  const env = makeEnv({ rows: [EXPECTED_HEADERS, ...seedRegistrations(40, {})] });
  const res = register(env);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'FULL');
  assert.equal(dataRows(env).length, 40);
  assert.equal(env.state.mails.length, 0);

  const other = register(env, { category: 'rookie-mens' });
  assert.equal(other.ok, true, 'other categories stay open');
});

for (const category of ['novice-mens', 'novice-womens', 'novice-mixed', 'rookie-mixed']) {
  test(category + ': accepts player 40 and refuses player 41 without saving files or sending mail', () => {
    const env = makeEnv({
      rows: [EXPECTED_HEADERS, ...seedRegistrations(39, { Category: LABEL[category] })]
    });
    const last = register(env, { category });
    assert.equal(last.ok, true);
    assert.equal(dataRows(env).length, 40);
    assert.equal(slotsGet(env).slots[category].taken, 40);
    const files = env.state.fileSeq;
    const mails = env.state.mails.length;
    const overflow = register(env, { category, email: 'overflow@example.com' });
    assert.equal(overflow.error, 'FULL');
    assert.equal(dataRows(env).length, 40);
    assert.equal(env.state.fileSeq, files);
    assert.equal(env.state.mails.length, mails);
  });
}

test('Rejected rows are not counted toward the cap', () => {
  const env = makeEnv({
    rows: [
      EXPECTED_HEADERS,
      ...seedRegistrations(39, {}),
      ...seedRegistrations(3, { Status: 'Rejected' })
    ]
  });
  assert.equal(register(env).ok, true, 'the 40th player fits');
  const next = register(env, { email: 'late@example.com' });
  assert.equal(next.error, 'FULL', 'the 41st player does not fit');
});

test('register returns BUSY when the lock cannot be taken', () => {
  const env = makeEnv();
  env.state.lockBusy = true;
  const res = register(env);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'BUSY');
});

test('makeRef_ maps random values onto the first and last alphabet characters', () => {
  const env = makeEnv();
  assert.equal(env.ctx.makeRef_(() => 0), 'DFR-AAAAAA');
  assert.equal(env.ctx.makeRef_(() => 0.999), 'DFR-999999');
});

test('generated refs use only the allowed alphabet', () => {
  const env = makeEnv();
  for (let i = 0; i < 200; i++) {
    const ref = env.ctx.makeRef_();
    assert.match(ref, REF_PATTERN);
    assert.doesNotMatch(ref, /[01IO]/);
  }
});

// ---------------------------------------------------------------------------
// Formula injection and HTML escaping
// ---------------------------------------------------------------------------

test('user text that starts with a formula character is prefixed with an apostrophe', () => {
  const env = makeEnv();
  const res = register(env, {
    fullName: '=HYPERLINK("https://evil.example","x")',
    barangay: '+Zone 9',
    partnerName: '@Partner Name',
    paymentRef: '-GC-99999',
    clubName: '=Club'
  });
  assert.equal(res.ok, true);
  const row = dataRows(env)[0];
  assert.equal(cell(row, 'Full Name'), '\'=HYPERLINK("https://evil.example","x")');
  assert.equal(cell(row, 'Barangay'), "'+Zone 9");
  assert.equal(cell(row, 'Partner Name'), "'@Partner Name");
  assert.equal(cell(row, 'Payment Ref (player)'), "'-GC-99999");
  assert.equal(cell(row, 'Club Name'), "'=Club");
});

test('user text is escaped in the HTML emails', () => {
  const env = makeEnv();
  register(env, { fullName: '<script>alert(1)</script>', partnerName: 'Ann & "Bo"' });
  const playerMail = mailTo(env, 'juan@example.com');
  assert.equal(playerMail.htmlBody.includes('<script>'), false);
  assert.ok(playerMail.htmlBody.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(playerMail.htmlBody.includes('Ann &amp; &quot;Bo&quot;'));
  assert.equal(organizerMail(env).htmlBody.includes('<script>'), false);
});

// ---------------------------------------------------------------------------
// Category tabs
// ---------------------------------------------------------------------------

test('buildPairs_ pairs mutual partners as Complete with no note', () => {
  const env = makeEnv();
  const rows = [
    pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'Juan Dela Cruz', 'Partner Name': 'Pedro Santos', Email: 'juan@x.com', Phone: "'+639171234567" }),
    pRow({ Ref: 'DFR-BBBBB2', 'Full Name': 'Pedro Santos', 'Partner Name': 'Juan Dela Cruz', Email: 'pedro@x.com' })
  ];
  const pairs = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0], PAIR_HEADERS);
  assert.equal(pairs[1][0], 1);
  assert.equal(pairs[1][1], 'Complete');
  assert.equal(pairs[1][2], 'Juan Dela Cruz');
  assert.equal(pairs[1][3], 'DFR-AAAAA1');
  assert.equal(pairs[1][6], "'+639171234567");
  assert.equal(pairs[1][9], 'Pedro Santos');
  assert.equal(pairs[1][10], 'DFR-BBBBB2');
  assert.equal(pairs[1][16], '');
});

test('buildPairs_ marks a one-way match Complete with the exact-match note', () => {
  const env = makeEnv();
  const rows = [
    pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'Juan Dela Cruz', 'Partner Name': 'Pedro Santos' }),
    pRow({ Ref: 'DFR-BBBBB2', 'Full Name': 'Pedro Santos', 'Partner Name': 'Ana Cruz' })
  ];
  const pairs = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(pairs.length, 2);
  assert.equal(pairs[1][1], 'Complete');
  assert.equal(pairs[1][16], 'Partner names do not match exactly. Check.');
});

test('buildPairs_ keeps an exact pair together when an earlier player names one of them', () => {
  const env = makeEnv();
  const rows = [
    pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'Ana Cruz', 'Partner Name': 'Pedro Santos' }),
    pRow({ Ref: 'DFR-BBBBB2', 'Full Name': 'Pedro Santos', 'Partner Name': 'Juan Dela Cruz' }),
    pRow({ Ref: 'DFR-CCCCC3', 'Full Name': 'Juan Dela Cruz', 'Partner Name': 'Pedro Santos' })
  ];
  const pairs = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(pairs.length, 3);
  assert.equal(pairs[1][2], 'Ana Cruz');
  assert.equal(pairs[1][1], 'Waiting for partner');
  assert.equal(pairs[2][2], 'Pedro Santos');
  assert.equal(pairs[2][9], 'Juan Dela Cruz');
  assert.equal(pairs[2][16], '');
});

test('buildPairs_ shows a waiting row with its named partner', () => {
  const env = makeEnv();
  const rows = [pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'Juan Dela Cruz', 'Partner Name': 'Pedro Santos' })];
  const pairs = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(pairs.length, 2);
  assert.equal(pairs[1][1], 'Waiting for partner');
  assert.equal(pairs[1][2], 'Juan Dela Cruz');
  assert.equal(pairs[1][9], '');
  assert.equal(pairs[1][16], 'Named partner: Pedro Santos');
});

test('buildPairs_ leaves a player waiting when the only partner was Rejected', () => {
  const env = makeEnv();
  const rows = [
    pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'Juan Dela Cruz', 'Partner Name': 'Pedro Santos' }),
    pRow({ Ref: 'DFR-BBBBB2', 'Full Name': 'Pedro Santos', 'Partner Name': 'Juan Dela Cruz', Status: 'Rejected' })
  ];
  const pairs = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(pairs.length, 2, 'the rejected row is excluded');
  assert.equal(pairs[1][1], 'Waiting for partner');
});

test('buildPairs_ ignores case, punctuation, and extra spaces in names', () => {
  const env = makeEnv();
  const rows = [
    pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'JUAN dela-Cruz.', 'Partner Name': 'pedro   santos!' }),
    pRow({ Ref: 'DFR-BBBBB2', 'Full Name': 'Pedro Santos', 'Partner Name': 'juan dela cruz' })
  ];
  const pairs = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(pairs.length, 2);
  assert.equal(pairs[1][1], 'Complete');
  assert.equal(pairs[1][16], '');
});

test('buildPairs_ keeps categories separate', () => {
  const env = makeEnv();
  const rows = [
    pRow({ Ref: 'DFR-AAAAA1', 'Full Name': 'Juan Dela Cruz', 'Partner Name': 'Pedro Santos' }),
    pRow({ Ref: 'DFR-BBBBB2', 'Full Name': 'Pedro Santos', 'Partner Name': 'Juan Dela Cruz', Category: LABEL['rookie-mens'] })
  ];
  const novice = plain(env.ctx.buildPairs_(rows, 'novice-mens'));
  assert.equal(novice.length, 2);
  assert.equal(novice[1][1], 'Waiting for partner');

  const rookie = plain(env.ctx.buildPairs_(rows, 'rookie-mens'));
  assert.equal(rookie.length, 2);
  assert.equal(rookie[1][1], 'Waiting for partner');
});

test('register rebuilds the matching category tab with the pair', () => {
  const env = makeEnv();
  const first = register(env);
  const second = register(env, {
    fullName: 'Pedro Santos',
    partnerName: 'Juan Dela Cruz',
    email: 'pedro@example.com'
  });
  assert.equal(second.ok, true);

  const tab = env.state.sheets["Novice Men's"];
  assert.ok(tab, 'tab exists');
  assert.equal(tab.frozen, 1);
  assert.deepEqual(plain(tab.rows[0]), PAIR_HEADERS);
  assert.equal(tab.rows.length, 2);
  assert.equal(tab.rows[1][1], 'Complete');
  assert.equal(tab.rows[1][3], first.ref);
  assert.equal(tab.rows[1][10], second.ref);
});

test('register rebuilds only its own category tab', () => {
  const env = makeEnv();
  register(env);
  assert.ok(env.state.sheets["Novice Men's"], 'own tab written');
  assert.equal(env.state.sheets["Rookie Mixed"], undefined, 'other tab untouched');
});

test('verify updates the player status in the category tab', () => {
  const env = makeEnv();
  const first = register(env);
  const res = call(env, { action: 'verify', key: ADMIN_KEY, ref: first.ref, result: { verdict: 'Verified' } });
  assert.equal(res.ok, true);
  const tab = env.state.sheets["Novice Men's"];
  assert.equal(tab.rows[1][4], 'Verified');
});

test('rebuildTabs writes the rookie tab from Registrations', () => {
  const env = makeEnv();
  register(env, { category: 'rookie-womens', fullName: 'Ana Reyes', partnerName: 'Maria Lopez', email: 'ana@example.com' });
  env.ctx.rebuildTabs();
  const tab = env.state.sheets["Rookie Women's"];
  assert.equal(tab.rows.length, 2);
  assert.equal(tab.rows[1][2], 'Ana Reyes');
  assert.equal(tab.rows[1][1], 'Waiting for partner');
});

// ---------------------------------------------------------------------------
// Email failure
// ---------------------------------------------------------------------------

test('an email failure still returns ok and records the failure', () => {
  const env = makeEnv();
  env.state.mailFailWith = 'Service invoked too many times';
  const res = register(env);
  assert.equal(res.ok, true);
  assert.match(res.ref, REF_PATTERN);
  const row = dataRows(env)[0];
  assert.equal(cell(row, 'Status'), 'Pending check');
  assert.equal(cell(row, 'Player Email Sent'), 'failed: Service invoked too many times');
  assert.equal(cell(row, 'Organizer Email Sent'), 'failed: Service invoked too many times');
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

test('admin endpoints return FORBIDDEN for a wrong key', () => {
  const env = makeEnv();
  for (const action of ['pending', 'verify', 'refs']) {
    const res = call(env, { action, key: 'wrong', ref: 'DFR-AAAAAA', result: { verdict: 'Verified' } });
    assert.equal(res.ok, false, action);
    assert.equal(res.error, 'FORBIDDEN', action);
  }
});

test('admin endpoints return FORBIDDEN when no key is given', () => {
  const env = makeEnv();
  assert.equal(call(env, { action: 'pending' }).error, 'FORBIDDEN');
});

test('admin endpoints return FORBIDDEN when ADMIN_KEY is not set', () => {
  const env = makeEnv({ props: { ADMIN_KEY: '' } });
  assert.equal(call(env, { action: 'refs', key: '' }).error, 'FORBIDDEN');
});

test('pending returns receipt base64 for pending rows only', () => {
  const env = makeEnv();
  const res = register(env);
  const pending = call(env, { action: 'pending', key: ADMIN_KEY });
  assert.equal(pending.ok, true);
  assert.equal(pending.items.length, 1);
  const item = pending.items[0];
  assert.equal(item.ref, res.ref);
  assert.equal(item.row, 2);
  assert.equal(item.fullName, 'Juan Dela Cruz');
  assert.equal(item.email, 'juan@example.com');
  assert.equal(item.category, "Novice Men's Doubles");
  assert.equal(item.paymentRef, 'GC-123456');
  assert.equal(item.fileName, res.ref + '-gcash.jpg');
  assert.equal(item.mimeType, 'image/jpeg');
  assert.equal(item.base64, b64(JPEG));
  assert.equal(Buffer.from(item.base64, 'base64').length, JPEG.length);
});

test('pending returns at most 10 rows', () => {
  const env = makeEnv({
    rows: [EXPECTED_HEADERS, ...seedRegistrations(12, { 'Receipt File ID': 'file1' })]
  });
  env.state.files.file1 = { getBlob: () => makeBlob(JPEG.slice(), 'image/jpeg', 'x.jpg') };
  const res = call(env, { action: 'pending', key: ADMIN_KEY });
  assert.equal(res.items.length, 10);
});

test('verify writes the result columns and sets the status', () => {
  const env = makeEnv();
  const { ref } = register(env);
  const res = call(env, {
    action: 'verify',
    key: ADMIN_KEY,
    ref,
    result: {
      verdict: 'Needs review',
      amount: '1000.00',
      referenceNo: 'REF123',
      txnDate: '2026-10-20',
      sender: 'Juan D.',
      recipient: 'Dink Team',
      ocrText: 'x'.repeat(5000),
      tamperScore: 12,
      flags: ['amount low', 'late'],
      imageHash: 'abc123',
      checkedAt: '2026-10-21T01:00:00Z'
    }
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'Needs review');

  const row = dataRows(env)[0];
  assert.equal(cell(row, 'Status'), 'Needs review');
  assert.equal(cell(row, 'Verdict'), 'Needs review');
  assert.equal(cell(row, 'OCR Amount'), '1000.00');
  assert.equal(cell(row, 'OCR Reference No'), "'REF123");
  assert.equal(cell(row, 'OCR Txn Date'), '2026-10-20');
  assert.equal(cell(row, 'OCR Sender'), 'Juan D.');
  assert.equal(cell(row, 'OCR Recipient'), 'Dink Team');
  assert.equal(cell(row, 'Tamper Score'), 12);
  assert.equal(cell(row, 'Flags'), 'amount low; late');
  assert.equal(cell(row, 'Image Hash'), 'abc123');
  assert.equal(cell(row, 'Checked At'), '2026-10-21T01:00:00Z');
  assert.equal(cell(row, 'OCR Text').length, 4000);
  assert.equal(cell(row, 'Player Email Sent'), 'yes', 'other columns untouched');
});

test('verify rejects an invalid verdict and an unknown ref', () => {
  const env = makeEnv();
  const { ref } = register(env);
  const bad = call(env, { action: 'verify', key: ADMIN_KEY, ref, result: { verdict: 'Maybe' } });
  assert.equal(bad.error, 'INVALID');
  assert.equal(bad.field, 'result.verdict');
  const missing = call(env, { action: 'verify', key: ADMIN_KEY, ref: 'DFR-ZZZZZZ', result: { verdict: 'Verified' } });
  assert.equal(missing.error, 'NOT_FOUND');
});

test('refs returns only checked rows with their reference and hash', () => {
  const env = makeEnv();
  const first = register(env);
  register(env, { email: 'other@example.com' });
  call(env, {
    action: 'verify',
    key: ADMIN_KEY,
    ref: first.ref,
    result: { verdict: 'Verified', referenceNo: 'REF-1', imageHash: 'hash-1', checkedAt: '2026-10-21T02:00:00Z' }
  });
  const res = call(env, { action: 'refs', key: ADMIN_KEY });
  assert.equal(res.ok, true);
  assert.deepEqual(res.refs, [{ ref: first.ref, referenceNo: 'REF-1', imageHash: 'hash-1' }]);
});

// ---------------------------------------------------------------------------
// Receipt amount (Drive OCR)
// ---------------------------------------------------------------------------

test('showsFee_ finds 1200 in the usual receipt formats', () => {
  const env = makeEnv();
  const yes = ['Amount ₱1,200.00', 'PHP 1200', 'P1 200.00', 'Total: 1,200', 'Sent\n1,200.0\nto Diana'];
  const no = ['Amount ₱1,000.00', '₱11,200.00', '₱1,200.50', '12000', 'Ref 412003', '₱2,400.00', ''];
  for (const t of yes) assert.equal(env.ctx.showsFee_(t), true, t);
  for (const t of no) assert.equal(env.ctx.showsFee_(t), false, t);
});

test('register refuses a receipt that does not show 1,200 and saves nothing', () => {
  const env = makeEnv({ state: { ocrText: 'GoTyme Bank\nAmount ₱1,000.00' } });
  const res = register(env);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'INVALID');
  assert.equal(res.field, 'receipt.amount');
  assert.match(res.message, /₱1,200/);
  assert.equal(env.state.sheets[SHEET].rows.length, 1, 'no row appended');
  assert.equal(env.state.mails.length, 0, 'no email sent');
});

test('register reads the receipt through Drive OCR and deletes the temporary doc', () => {
  const env = makeEnv();
  const res = register(env);
  assert.equal(res.ok, true);
  const methods = env.state.ocrCalls.map((c) => c.method + ' ' + c.url.replace(/\?.*/, ''));
  assert.deepEqual(methods, [
    'post https://www.googleapis.com/upload/drive/v3/files',
    'get https://www.googleapis.com/drive/v3/files/ocr-doc-1/export',
    'delete https://www.googleapis.com/drive/v3/files/ocr-doc-1'
  ]);
  assert.ok(env.state.ocrCalls[0].url.includes('ocrLanguage=en'));
});

test('register accepts the entry when OCR is unavailable', () => {
  for (const ocrMode of ['uploadFail', 'throw']) {
    const env = makeEnv({ state: { ocrMode } });
    const res = register(env);
    assert.equal(res.ok, true, ocrMode);
    assert.equal(env.state.sheets[SHEET].rows.length, 2, ocrMode);
    assert.ok(env.state.logs.some((l) => /OCR/.test(l)), ocrMode);
  }
});
