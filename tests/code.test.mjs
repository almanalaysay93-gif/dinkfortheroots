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

// Written out here on purpose, separate from Code.gs, so a header change is caught.
const EXPECTED_HEADERS = [
  'Ref', 'Submitted At', 'Status', 'Full Name', 'Email', 'Phone', 'Municipality',
  'Barangay', 'Category', 'Partner Name', 'Shirt Size', 'Payment Ref (player)',
  'Receipt File ID', 'Receipt URL', 'Verdict', 'OCR Amount', 'OCR Reference No',
  'OCR Txn Date', 'OCR Sender', 'OCR Recipient', 'Tamper Score', 'Flags',
  'Image Hash', 'Checked At', 'OCR Text', 'Player Email Sent', 'Organizer Email Sent'
];

const LABEL = {
  'novice-mens': "Novice Men's Doubles",
  'novice-womens': "Novice Women's Doubles",
  'novice-mixed': 'Novice Mixed Doubles',
  'rookie': 'Rookie Doubles'
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
    posterMode: 'ok'
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
      newBlob: (bytes, mime, name) => makeBlob(Array.from(bytes), mime, name),
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
    UrlFetchApp: {
      fetch(url) {
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

function registerBody(player = {}, receipt = {}, extra = {}) {
  return {
    action: 'register',
    player: validPlayer(player),
    receipt: validReceipt(receipt),
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('setup creates the header in contract order and freezes row 1', () => {
  const env = makeEnv({ withSheet: false, withFolder: false });
  for (const key of ['ADMIN_KEY', 'ORGANIZER_EMAIL', 'POSTER_URL', 'RECEIPT_FOLDER_ID']) {
    delete env.state.props[key];
  }

  env.ctx.setup();

  const sheet = env.state.sheets[SHEET];
  assert.deepEqual(plain(sheet.rows[0]), EXPECTED_HEADERS);
  assert.equal(sheet.frozen, 1);
  assert.equal(env.state.folders.length, 1);
  assert.equal(env.state.folders[0].name, 'Dink for the Roots Receipts');
  assert.equal(env.state.props.RECEIPT_FOLDER_ID, env.state.folders[0].id);
  assert.equal(env.state.props.ORGANIZER_EMAIL, 'ibanezdianarose9@gmail.com');
  assert.equal(env.state.props.POSTER_URL, '');
  assert.match(env.state.props.ADMIN_KEY, /^[0-9a-f-]{36}$/);
  assert.ok(env.state.logs.some((l) => l.includes(env.state.props.ADMIN_KEY)));
});

test('setup keeps an existing admin key and reuses the receipt folder', () => {
  const env = makeEnv();
  env.ctx.setup();
  env.ctx.setup();
  assert.equal(env.state.props.ADMIN_KEY, ADMIN_KEY);
  assert.equal(env.state.folders.length, 1);
});

test('setup refuses a sheet whose header row differs from the contract', () => {
  const env = makeEnv({ rows: [['Wrong', 'Header']] });
  assert.throws(() => env.ctx.setup(), /does not match the contract header/);
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

test('slots returns zero counts for an empty sheet with cap 36', () => {
  const env = makeEnv();
  const res = slotsGet(env);
  assert.equal(res.ok, true);
  assert.equal(res.open, true);
  for (const key of Object.keys(LABEL)) {
    assert.deepEqual(res.slots[key], { taken: 0, cap: 36 });
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
      ...seedRegistrations(1, { Category: LABEL.rookie })
    ]
  });
  const res = slotsGet(env);
  assert.equal(res.slots['novice-mens'].taken, 2);
  assert.equal(res.slots.rookie.taken, 1);
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
  const playerMail = env.state.mails.find((m) => m.to === 'juan@example.com');
  const organizerMail = env.state.mails.find((m) => m.to === 'org@example.com');
  assert.ok(playerMail, 'player mail sent');
  assert.ok(organizerMail, 'organizer mail sent');
  assert.equal(playerMail.name, 'Dink for the Roots');
  assert.equal(playerMail.attachments.length, 1);
  assert.equal(playerMail.attachments[0].name, 'Dink-for-the-Roots-poster.jpg');
  assert.ok(playerMail.body.includes(res.ref));
  assert.ok(playerMail.body.includes('Saturday, December 5, 2026'));
  assert.ok(playerMail.body.includes('Pickle Park, Roxas Extension, Digos City'));
  assert.ok(playerMail.htmlBody.includes(res.ref));
  assert.ok(organizerMail.body.includes('https://drive.example/file1'));
  assert.ok(organizerMail.body.includes('https://sheet.example/test'));
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
  const playerMail = env.state.mails.find((m) => m.to === 'juan@example.com');
  assert.equal(playerMail.attachments, undefined);
});

test('register succeeds without the poster when the poster fetch fails', () => {
  const env = makeEnv({ props: { POSTER_URL: 'https://posters.example/poster.jpg' } });
  env.state.posterMode = 'throw';
  const res = register(env);
  assert.equal(res.ok, true);
  assert.equal(cell(dataRows(env)[0], 'Player Email Sent'), 'yes');
  const playerMail = env.state.mails.find((m) => m.to === 'juan@example.com');
  assert.equal(playerMail.attachments, undefined);
});

test('register succeeds without the poster when the poster returns HTTP 404', () => {
  const env = makeEnv({ props: { POSTER_URL: 'https://posters.example/missing.jpg' } });
  env.state.posterMode = 'missing';
  const res = register(env);
  assert.equal(res.ok, true);
  assert.equal(env.state.mails.find((m) => m.to === 'juan@example.com').attachments, undefined);
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
// Register: validation
// ---------------------------------------------------------------------------

const VALIDATION_CASES = [
  ['bad email', { email: 'juan@' }, {}, {}, 'email'],
  ['bad phone', { phone: '12345' }, {}, {}, 'phone'],
  ['phone with wrong prefix', { phone: '0817 123 4567' }, {}, {}, 'phone'],
  ['municipality outside list', { municipality: 'Davao City' }, {}, {}, 'municipality'],
  ['bad shirt size', { shirtSize: 'XXL' }, {}, {}, 'shirtSize'],
  ['bad category', { category: 'open' }, {}, {}, 'category'],
  ['oversize receipt', {}, { base64: b64([...JPEG, ...Array(5 * 1024 * 1024).fill(0)]) }, {}, 'receipt.base64'],
  ['wrong mime type', {}, { mimeType: 'application/pdf' }, {}, 'receipt.mimeType'],
  ['mime does not match bytes', {}, { mimeType: 'image/png' }, {}, 'receipt.mimeType'],
  ['no consent', {}, {}, { consent: false }, 'consent'],
  ['invalid base64', {}, { base64: 'not base64!' }, {}, 'receipt.base64'],
  ['partner same as player', { partnerName: 'juan dela cruz' }, {}, {}, 'partnerName']
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
    assert.equal(Object.keys(env.state.files).length, 0, 'no receipt saved');
  });
}

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
  const second = register(env, { category: 'rookie' });
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

test('register returns FULL when 36 rows of the category are taken', () => {
  const env = makeEnv({ rows: [EXPECTED_HEADERS, ...seedRegistrations(36, {})] });
  const res = register(env);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'FULL');
  assert.equal(dataRows(env).length, 36);
  assert.equal(env.state.mails.length, 0);

  const other = register(env, { category: 'rookie' });
  assert.equal(other.ok, true, 'other categories stay open');
});

test('Rejected rows are not counted toward the cap', () => {
  const env = makeEnv({
    rows: [
      EXPECTED_HEADERS,
      ...seedRegistrations(35, {}),
      ...seedRegistrations(3, { Status: 'Rejected' })
    ]
  });
  assert.equal(register(env).ok, true, 'the 36th player fits');
  const next = register(env, { email: 'late@example.com' });
  assert.equal(next.error, 'FULL', 'the 37th player does not fit');
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
    paymentRef: '-GC-99999'
  });
  assert.equal(res.ok, true);
  const row = dataRows(env)[0];
  assert.equal(cell(row, 'Full Name'), '\'=HYPERLINK("https://evil.example","x")');
  assert.equal(cell(row, 'Barangay'), "'+Zone 9");
  assert.equal(cell(row, 'Partner Name'), "'@Partner Name");
  assert.equal(cell(row, 'Payment Ref (player)'), "'-GC-99999");
});

test('user text is escaped in the HTML emails', () => {
  const env = makeEnv();
  register(env, { fullName: '<script>alert(1)</script>', partnerName: 'Ann & "Bo"' });
  const playerMail = env.state.mails.find((m) => m.to === 'juan@example.com');
  assert.equal(playerMail.htmlBody.includes('<script>'), false);
  assert.ok(playerMail.htmlBody.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(playerMail.htmlBody.includes('Ann &amp; &quot;Bo&quot;'));
  const organizerMail = env.state.mails.find((m) => m.to === 'org@example.com');
  assert.equal(organizerMail.htmlBody.includes('<script>'), false);
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
  assert.equal(cell(row, 'OCR Reference No'), 'REF123');
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
