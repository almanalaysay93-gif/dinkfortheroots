/**
 * Dink for the Roots registration backend.
 * Google Apps Script, V8. Bound to the registration Sheet, or standalone with SHEET_ID.
 * API contract: ORCHESTRATOR.md in the project root.
 */

var SHEET_NAME = 'Registrations';
// Used when the script is standalone (not opened from the Sheet's Extensions menu).
var SHEET_ID = '1nU4mEsdvNxyiP4gskgR2rZKjcnXwO9tcI4cob9Cv2YA';
var RECEIPT_FOLDER_NAME = 'Dink for the Roots Receipts';
var VALID_ID_FOLDER_NAME = 'Dink for the Roots Valid IDs';
var SENDER_NAME = 'Dink for the Roots';
var TIME_ZONE = 'Asia/Manila';
var DEFAULT_ORGANIZER_EMAILS = ['ibanezdianarose9@gmail.com', 'aceyorkbasilan@gmail.com'];
var CUTOFF_ISO = '2026-11-20T23:59:59+08:00';
var EVENT_DATE_TEXT = 'Saturday, December 5, 2026';
var EVENT_VENUE_TEXT = 'Pickle Park, Roxas Extension, Digos City';
var CATEGORY_CAP = 40;
var CLUB_NAME_MAX = 100;
var FEE_TEXT = '₱1,200';
var DRIVE_API = 'https://www.googleapis.com/drive/v3/files/';
var DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
var LOCK_WAIT_MS = 20000;
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
var OCR_TEXT_MAX = 4000;
var PENDING_BATCH_SIZE = 10;
var POSTER_FILE_NAME = 'Dink-for-the-Roots-poster.jpg';
var PENDING_STATUS = 'Pending check';
var REJECTED_STATUS = 'Rejected';
var REF_PREFIX = 'DFR-';
var REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var REF_LENGTH = 6;
var REF_PATTERN = /^DFR-[A-HJ-NP-Z2-9]{6}$/;
var VERDICTS = ['Verified', 'Needs review', 'Suspect'];
var IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
var PARTNER_NOTE = 'Partner names do not match exactly. Check.';

var CATEGORIES = {
  'novice-mens': "Novice Men's Doubles",
  'novice-womens': "Novice Women's Doubles",
  'novice-mixed': 'Novice Mixed Doubles',
  'rookie-mens': "Rookie Men's Doubles",
  'rookie-womens': "Rookie Women's Doubles",
  'rookie-mixed': 'Rookie Mixed Doubles'
};

var CATEGORY_TABS = {
  'novice-mens': "Novice Men's",
  'novice-womens': "Novice Women's",
  'novice-mixed': 'Novice Mixed',
  'rookie-mens': "Rookie Men's",
  'rookie-womens': "Rookie Women's",
  'rookie-mixed': 'Rookie Mixed'
};

var SHIRT_SIZES = ['K8', 'K10', 'K12', 'K14', 'K16', 'K18', 'K20', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

var MUNICIPALITIES = [
  'Digos City', 'Bansalan', 'Hagonoy', 'Kiblawan', 'Magsaysay',
  'Malalag', 'Matanao', 'Padada', 'Santa Cruz', 'Sulop'
];

var HEADERS = [
  'Ref', 'Submitted At', 'Status', 'Full Name', 'Email', 'Phone', 'Municipality',
  'Barangay', 'Category', 'Partner Name', 'Club Name', 'Shirt Size', 'Payment Ref (player)',
  'Receipt File ID', 'Receipt URL', 'Valid ID File ID', 'Valid ID URL', 'Verdict', 'OCR Amount',
  'OCR Reference No', 'OCR Txn Date', 'OCR Sender', 'OCR Recipient', 'Tamper Score', 'Flags',
  'Image Hash', 'Checked At', 'OCR Text', 'Player Email Sent', 'Organizer Email Sent'
];

var PAIR_HEADERS = [
  'Pair No', 'Pair Status', 'Player 1', 'P1 Ref', 'P1 Status', 'P1 Club', 'P1 Phone', 'P1 Email', 'P1 Shirt',
  'Player 2', 'P2 Ref', 'P2 Status', 'P2 Club', 'P2 Phone', 'P2 Email', 'P2 Shirt', 'Note'
];

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  return respond_(function () {
    var action = e && e.parameter ? e.parameter.action : '';
    if (action !== 'slots') {
      throw apiError_('BAD_ACTION', 'Unknown action. Use action=slots.');
    }
    return getSlots_();
  });
}

function doPost(e) {
  return respond_(function () {
    var body = parseBody_(e);
    switch (body.action) {
      case 'slots':
        return getSlots_();
      case 'register':
        return registerGuest_(body);
      case 'pending':
        requireAdmin_(body.key);
        return listPending_();
      case 'verify':
        requireAdmin_(body.key);
        return verifyRegistration_(body.ref, body.result);
      case 'refs':
        requireAdmin_(body.key);
        return listRefs_();
      default:
        throw apiError_('BAD_ACTION', 'Unknown action.');
    }
  });
}

function respond_(handler) {
  var result;
  try {
    result = handler();
  } catch (err) {
    result = errorResult_(err);
  }
  return jsonOutput_(result);
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResult_(err) {
  if (err && err.code) {
    var out = { ok: false, error: err.code, message: err.message };
    if (err.field) {
      out.field = err.field;
    }
    return out;
  }
  Logger.log('SERVER: ' + (err && err.stack ? err.stack : err));
  return { ok: false, error: 'SERVER', message: 'Server error. Please try again later.' };
}

function apiError_(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function invalid_(message, field) {
  var err = apiError_('INVALID', message);
  err.field = field;
  return err;
}

function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) {
    throw apiError_('BAD_REQUEST', 'Request body is empty.');
  }
  var body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw apiError_('BAD_JSON', 'Request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object') {
    throw apiError_('BAD_REQUEST', 'Request body must be a JSON object.');
  }
  return body;
}

// ---------------------------------------------------------------------------
// Setup (run once in the Apps Script editor)
// ---------------------------------------------------------------------------

function setup() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() <= 1) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else {
    var current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (!sameHeaders_(current)) {
      throw new Error('Row 1 of ' + SHEET_NAME + ' does not match the contract header. Fix it, then run setup again.');
    }
  }
  sheet.setFrozenRows(1);

  var props = PropertiesService.getScriptProperties();
  ensureFolder_(props, 'RECEIPT_FOLDER_ID', RECEIPT_FOLDER_NAME);
  ensureFolder_(props, 'VALID_ID_FOLDER_ID', VALID_ID_FOLDER_NAME);
  if (!props.getProperty('ORGANIZER_EMAIL')) {
    props.setProperty('ORGANIZER_EMAIL', DEFAULT_ORGANIZER_EMAILS.join(', '));
  }
  if (!props.getProperty('POSTER_URL')) {
    props.setProperty('POSTER_URL', '');
  }
  if (!props.getProperty('ADMIN_KEY')) {
    props.setProperty('ADMIN_KEY', Utilities.getUuid());
  }
  rebuildCategoryTabs_();
  Logger.log('ADMIN_KEY: ' + props.getProperty('ADMIN_KEY'));
  Logger.log('Setup complete. Set POSTER_URL in Project Settings > Script properties.');
}

function sameHeaders_(current) {
  return HEADERS.every(function (name, i) {
    return current[i] === name;
  });
}

function ensureFolder_(props, propName, folderName) {
  if (props.getProperty(propName)) {
    return;
  }
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  props.setProperty(propName, folder.getId());
}

// ---------------------------------------------------------------------------
// Sheet access
// ---------------------------------------------------------------------------

function getSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw apiError_('NOT_SETUP', 'Run setup() in the Apps Script editor first.');
  }
  return sheet;
}

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) {
    return [];
  }
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return values.map(function (cells, index) {
    var row = { _row: index + 2 };
    HEADERS.forEach(function (name, col) {
      row[name] = cells[col];
    });
    return row;
  });
}

function updateRow_(sheet, rowNumber, changes) {
  var range = sheet.getRange(rowNumber, 1, 1, HEADERS.length);
  var cells = range.getValues()[0];
  Object.keys(changes).forEach(function (name) {
    var col = HEADERS.indexOf(name);
    if (col < 0) {
      throw new Error('Unknown column: ' + name);
    }
    cells[col] = changes[name];
  });
  range.setValues([cells]);
}

function rowFromObject_(obj) {
  return HEADERS.map(function (name) {
    return obj[name] === undefined ? '' : obj[name];
  });
}

function countCategory_(rows, categoryKey) {
  var label = CATEGORIES[categoryKey];
  return rows.filter(function (row) {
    return row.Category === label && row.Status !== REJECTED_STATUS;
  }).length;
}

function findDuplicate_(rows, player) {
  var label = CATEGORIES[player.category];
  return rows.find(function (row) {
    return String(row.Email).toLowerCase() === player.email
      && row.Category === label
      && row.Status !== REJECTED_STATUS;
  });
}

// ---------------------------------------------------------------------------
// Slots and registration window
// ---------------------------------------------------------------------------

function now_() {
  return new Date();
}

function isOpen_() {
  return now_().getTime() <= Date.parse(CUTOFF_ISO);
}

function getSlots_() {
  var rows = readRows_(getSheet_());
  var slots = {};
  Object.keys(CATEGORIES).forEach(function (key) {
    slots[key] = { taken: countCategory_(rows, key), cap: CATEGORY_CAP };
  });
  return { ok: true, open: isOpen_(), closesAt: CUTOFF_ISO, slots: slots };
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

function validatePlayer_(input) {
  var p = input && typeof input === 'object' ? input : {};
  var player = {
    fullName: requireText_(p.fullName, 2, 100, 'fullName', 'Full name'),
    email: requireEmail_(p.email),
    phone: requirePhone_(p.phone),
    municipality: requireOption_(p.municipality, MUNICIPALITIES, 'municipality', 'Municipality'),
    barangay: requireText_(p.barangay, 2, 80, 'barangay', 'Barangay'),
    category: requireCategory_(p.category),
    partnerName: requireText_(p.partnerName, 2, 100, 'partnerName', 'Partner name'),
    clubName: optionalText_(p.clubName, CLUB_NAME_MAX, 'clubName', 'Club name'),
    shirtSize: requireOption_(p.shirtSize, SHIRT_SIZES, 'shirtSize', 'Shirt size'),
    paymentRef: requireText_(p.paymentRef, 3, 60, 'paymentRef', 'Payment reference')
  };
  if (normalizeName_(player.partnerName) === normalizeName_(player.fullName)) {
    throw invalid_('Partner name must differ from your name.', 'partnerName');
  }
  return player;
}

function requireText_(value, min, max, field, label) {
  var text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length < min || text.length > max) {
    throw invalid_(label + ' must be ' + min + ' to ' + max + ' characters.', field);
  }
  return text;
}

function optionalText_(value, max, field, label) {
  var text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length > max) {
    throw invalid_(label + ' must be ' + max + ' characters or fewer.', field);
  }
  return text;
}

function normalizeName_(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Letters and digits only, single spaces. Used to pair partners on the tabs.
function pairName_(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function requireEmail_(value) {
  var email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) {
    throw invalid_('Email address is not valid.', 'email');
  }
  return email;
}

function normalizePhone_(value) {
  var compact = typeof value === 'string' ? value.replace(/[\s\-()]/g, '') : '';
  if (/^09\d{9}$/.test(compact)) {
    return '+63' + compact.slice(1);
  }
  if (/^\+639\d{9}$/.test(compact)) {
    return compact;
  }
  return '';
}

function requirePhone_(value) {
  var phone = normalizePhone_(value);
  if (!phone) {
    throw invalid_('Phone must look like 09XXXXXXXXX or +639XXXXXXXXX.', 'phone');
  }
  return phone;
}

function requireOption_(value, options, field, label) {
  if (typeof value !== 'string' || options.indexOf(value.trim()) < 0) {
    throw invalid_(label + ' is not in the list.', field);
  }
  return value.trim();
}

function requireCategory_(value) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(CATEGORIES, value)) {
    throw invalid_('Category is not valid.', 'category');
  }
  return value;
}

// Shared by the payment receipt (fieldPrefix "receipt") and the valid ID (fieldPrefix "validId").
function validateImage_(input, fieldPrefix, label) {
  var r = input && typeof input === 'object' ? input : {};
  if (typeof r.base64 !== 'string' || r.base64.length === 0) {
    throw invalid_(label + ' file is missing.', fieldPrefix + '.base64');
  }
  var fileName = requireText_(r.fileName, 1, 120, fieldPrefix + '.fileName', label + ' file name');
  if (IMAGE_MIME_TYPES.indexOf(r.mimeType) < 0) {
    throw invalid_(label + ' must be a JPEG, PNG, or WebP image.', fieldPrefix + '.mimeType');
  }
  if (r.base64.length > MAX_IMAGE_BASE64_CHARS) {
    throw invalid_(label + ' is larger than 5 MB.', fieldPrefix + '.base64');
  }
  var bytes;
  try {
    bytes = Utilities.base64Decode(r.base64);
  } catch (err) {
    throw invalid_(label + ' file is not valid base64.', fieldPrefix + '.base64');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw invalid_(label + ' is larger than 5 MB.', fieldPrefix + '.base64');
  }
  if (sniffMime_(bytes) !== r.mimeType) {
    throw invalid_(label + ' content does not match its file type.', fieldPrefix + '.mimeType');
  }
  return { fileName: fileName, mimeType: r.mimeType, bytes: bytes };
}

function sniffMime_(bytes) {
  if (startsWithBytes_(bytes, 0, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWithBytes_(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) {
    return 'image/png';
  }
  if (startsWithBytes_(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes_(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  return '';
}

function startsWithBytes_(bytes, offset, signature) {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every(function (value, i) {
    return (bytes[offset + i] & 0xff) === value;
  });
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function safeCell_(value) {
  var text = value === undefined || value === null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

// Reference numbers must stay text: Sheets turns digit strings into numbers
// and drops digits after the 15th.
function textCell_(value) {
  var text = value === undefined || value === null ? '' : String(value);
  return text ? "'" + text : '';
}

function sanitizeFileName_(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEquals_(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function makeRef_(random) {
  var rnd = random || Math.random;
  var out = REF_PREFIX;
  for (var i = 0; i < REF_LENGTH; i++) {
    out += REF_ALPHABET.charAt(Math.floor(rnd() * REF_ALPHABET.length));
  }
  return out;
}

function uniqueRef_(existingRefs) {
  for (var attempt = 0; attempt < 50; attempt++) {
    var ref = makeRef_();
    if (existingRefs.indexOf(ref) < 0) {
      return ref;
    }
  }
  throw new Error('Could not create a unique reference.');
}

function formatNow_() {
  return Utilities.formatDate(now_(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
}

function getProperty_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function requireAdmin_(key) {
  var expected = getProperty_('ADMIN_KEY');
  if (!expected || typeof key !== 'string' || !safeEquals_(key, expected)) {
    throw apiError_('FORBIDDEN', 'Admin key is not valid.');
  }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

function registerGuest_(body) {
  if (!isOpen_()) {
    throw apiError_('CLOSED', 'Registration closed on November 20, 2026 at 11:59 PM.');
  }
  if (body.consent !== true) {
    throw invalid_('Consent is required.', 'consent');
  }
  var player = validatePlayer_(body.player);
  var receipt = validateImage_(body.receipt, 'receipt', 'Receipt');
  var validId = validateImage_(body.validId, 'validId', 'Valid ID');
  requireFeeOnReceipt_(receipt);
  var stored = withLock_(function () {
    return storeRegistration_(player, receipt, validId);
  });
  if (stored.duplicate) {
    return { ok: true, duplicate: true, ref: stored.ref };
  }
  var status = sendRegistrationEmails_(stored.ref, player, stored);
  try {
    updateRow_(getSheet_(), stored.row, {
      'Player Email Sent': status.player,
      'Organizer Email Sent': status.organizer
    });
  } catch (err) {
    Logger.log('Could not record email status for ' + stored.ref + ': ' + err);
  }
  return { ok: true, ref: stored.ref };
}

// ---------------------------------------------------------------------------
// Receipt amount (Google Drive OCR)
// ---------------------------------------------------------------------------

// Refuses a receipt whose text does not show 1,200. When OCR itself fails
// (Drive outage, quota), the entry is accepted and left for the receipt checker.
function requireFeeOnReceipt_(receipt) {
  var text = readReceiptText_(receipt);
  if (text === null) {
    Logger.log('Receipt OCR unavailable. Accepted for the receipt checker.');
    return;
  }
  if (!showsFee_(text)) {
    throw invalid_('This receipt does not show ' + FEE_TEXT + '. Pay ' + FEE_TEXT
      + ' and upload the full, unedited screenshot of that payment.', 'receipt.amount');
  }
}

// Pure. True when the text holds the amount 1200: "1200", "1,200", "1 200", "1,200.00".
// Not part of a bigger number (11,200 or 1,200.50).
function showsFee_(text) {
  var joined = String(text).replace(/(\d)[,\s](?=\d{3}(?!\d))/g, '$1');
  return /(?<![\d.])1200(?:\.0{1,2})?(?![\d]|\.\d)/.test(joined);
}

// Run from the editor: reads the newest receipt in the receipts folder and logs
// whether OCR found 1,200. Changes no data.
function testReceiptOcr() {
  var files = getReceiptFolder_().getFiles();
  var newest = null;
  while (files.hasNext()) {
    var f = files.next();
    if (!newest || f.getDateCreated() > newest.getDateCreated()) {
      newest = f;
    }
  }
  if (!newest) {
    Logger.log('No receipt in the folder yet.');
    return;
  }
  var blob = newest.getBlob();
  var text = readReceiptText_({ mimeType: blob.getContentType(), bytes: blob.getBytes() });
  Logger.log('File: ' + newest.getName());
  Logger.log(text === null ? 'OCR unavailable.' : 'Shows 1,200: ' + showsFee_(text) + '\n' + text.slice(0, 300));
}

// Text of the image through Drive OCR, or null when OCR is unavailable.
// The temporary Google Doc is deleted right after its text is read.
function readReceiptText_(image) {
  var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  var boundary = 'dfr' + Utilities.getUuid().replace(/-/g, '');
  var meta = JSON.stringify({ name: 'dfr-receipt-ocr', mimeType: 'application/vnd.google-apps.document' });
  var head = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + meta + '\r\n--' + boundary + '\r\nContent-Type: ' + image.mimeType + '\r\n\r\n').getBytes();
  var tail = Utilities.newBlob('\r\n--' + boundary + '--\r\n').getBytes();
  try {
    var upload = UrlFetchApp.fetch(DRIVE_UPLOAD_API + '?uploadType=multipart&ocrLanguage=en&fields=id', {
      method: 'post',
      contentType: 'multipart/related; boundary=' + boundary,
      payload: head.concat(Array.prototype.slice.call(image.bytes), tail),
      headers: auth,
      muteHttpExceptions: true
    });
    if (upload.getResponseCode() !== 200) {
      Logger.log('OCR upload returned HTTP ' + upload.getResponseCode());
      return null;
    }
    var id = JSON.parse(upload.getContentText()).id;
    try {
      var exported = UrlFetchApp.fetch(DRIVE_API + id + '/export?mimeType=text/plain', {
        headers: auth,
        muteHttpExceptions: true
      });
      if (exported.getResponseCode() !== 200) {
        Logger.log('OCR export returned HTTP ' + exported.getResponseCode());
        return null;
      }
      return exported.getContentText();
    } finally {
      UrlFetchApp.fetch(DRIVE_API + id, { method: 'delete', headers: auth, muteHttpExceptions: true });
    }
  } catch (err) {
    Logger.log('OCR failed: ' + err);
    return null;
  }
}

function withLock_(work) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    throw apiError_('BUSY', 'Registration is busy. Please try again.');
  }
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

function storeRegistration_(player, receipt, validId) {
  var sheet = getSheet_();
  var rows = readRows_(sheet);
  var existing = findDuplicate_(rows, player);
  if (existing) {
    return { duplicate: true, ref: existing.Ref };
  }
  if (countCategory_(rows, player.category) >= CATEGORY_CAP) {
    throw apiError_('FULL', 'This category is full.');
  }
  var ref = uniqueRef_(rows.map(function (row) {
    return row.Ref;
  }));
  var receiptFile = saveFile_(getReceiptFolder_(), ref + '-' + sanitizeFileName_(receipt.fileName), receipt);
  var validIdFile = saveFile_(getValidIdFolder_(), ref + '-ID-' + sanitizeFileName_(validId.fileName), validId);
  sheet.appendRow(rowFromObject_(buildRecord_(ref, player, receiptFile, validIdFile)));
  rebuildTabsSafely_(player.category);
  return {
    duplicate: false,
    ref: ref,
    row: sheet.getLastRow(),
    receiptUrl: receiptFile.getUrl(),
    validIdUrl: validIdFile.getUrl()
  };
}

function buildRecord_(ref, player, receiptFile, validIdFile) {
  return {
    'Ref': ref,
    'Submitted At': formatNow_(),
    'Status': PENDING_STATUS,
    'Full Name': safeCell_(player.fullName),
    'Email': player.email,
    // apostrophe keeps "+639..." as text instead of a number
    'Phone': "'" + player.phone,
    'Municipality': player.municipality,
    'Barangay': safeCell_(player.barangay),
    'Category': CATEGORIES[player.category],
    'Partner Name': safeCell_(player.partnerName),
    'Club Name': safeCell_(player.clubName),
    'Shirt Size': player.shirtSize,
    'Payment Ref (player)': textCell_(player.paymentRef),
    'Receipt File ID': receiptFile.getId(),
    'Receipt URL': receiptFile.getUrl(),
    'Valid ID File ID': validIdFile.getId(),
    'Valid ID URL': validIdFile.getUrl()
  };
}

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SHEET_ID);
}

function getReceiptFolder_() {
  var id = getProperty_('RECEIPT_FOLDER_ID');
  if (!id) {
    throw apiError_('NOT_SETUP', 'Run setup() in the Apps Script editor first.');
  }
  return DriveApp.getFolderById(id);
}

// Created on first use if setup() has not run yet.
function getValidIdFolder_() {
  ensureFolder_(PropertiesService.getScriptProperties(), 'VALID_ID_FOLDER_ID', VALID_ID_FOLDER_NAME);
  return DriveApp.getFolderById(getProperty_('VALID_ID_FOLDER_ID'));
}

function saveFile_(folder, fileName, upload) {
  var blob = Utilities.newBlob(upload.bytes, upload.mimeType, fileName);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return file;
}

// ---------------------------------------------------------------------------
// Emails (sent after the lock is released)
// ---------------------------------------------------------------------------

function sendRegistrationEmails_(ref, player, stored) {
  return {
    player: sendSafely_(function () {
      sendPlayerEmail_(ref, player);
    }),
    organizer: sendSafely_(function () {
      sendOrganizerEmail_(ref, player, stored);
    })
  };
}

function sendSafely_(send) {
  try {
    send();
    return 'yes';
  } catch (err) {
    var message = err && err.message ? err.message : String(err);
    return ('failed: ' + message).slice(0, 250);
  }
}

function sendPlayerEmail_(ref, player) {
  var poster = fetchPoster_();
  var options = {
    to: player.email,
    subject: 'Dink for the Roots: registration received (' + ref + ')',
    body: playerEmailText_(ref, player, !!poster),
    htmlBody: playerEmailHtml_(ref, player, !!poster),
    name: SENDER_NAME
  };
  if (poster) {
    options.attachments = [poster];
  }
  MailApp.sendEmail(options);
}

function fetchPoster_() {
  var url = getProperty_('POSTER_URL');
  if (!url) {
    return null;
  }
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('Poster fetch returned HTTP ' + response.getResponseCode());
      return null;
    }
    return response.getBlob().setName(POSTER_FILE_NAME);
  } catch (err) {
    Logger.log('Poster fetch failed: ' + err);
    return null;
  }
}

function clubPairs_(player) {
  return player.clubName ? [['Club', player.clubName]] : [];
}

function playerPairs_(ref, player) {
  return [
    ['Reference', ref],
    ['Category', CATEGORIES[player.category]],
    ['Partner', player.partnerName]
  ].concat(clubPairs_(player), [
    ['Shirt size', player.shirtSize],
    ['Date', EVENT_DATE_TEXT],
    ['Venue', EVENT_VENUE_TEXT]
  ]);
}

function playerEmailText_(ref, player, posterAttached) {
  var lines = [
    'Hi ' + player.fullName + ',',
    '',
    'Thank you for registering for Dink for the Roots, a pickleball fundraising tournament for Indigenous communities.',
    ''
  ].concat(playerPairs_(ref, player).map(function (pair) {
    return pair[0] + ': ' + pair[1];
  }), [
    '',
    'Your payment receipt will be checked. If anything is wrong with it, we will email you.',
    'Keep your reference number for your records.'
  ]);
  if (posterAttached) {
    lines.push('', 'The event poster is attached to this email.');
  }
  return lines.join('\n');
}

function playerEmailHtml_(ref, player, posterAttached) {
  var rows = htmlRows_(playerPairs_(ref, player));
  var poster = posterAttached ? '<p>The event poster is attached to this email.</p>' : '';
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#1d1d1d;max-width:560px;">'
    + '<h2 style="margin:0 0 12px;">Dink for the Roots</h2>'
    + '<p>Hi ' + escapeHtml_(player.fullName) + ',</p>'
    + '<p>Thank you for registering for Dink for the Roots, a pickleball fundraising tournament for Indigenous communities.</p>'
    + '<table style="border-collapse:collapse;">' + rows + '</table>'
    + '<p>Your payment receipt will be checked. If anything is wrong with it, we will email you.</p>'
    + '<p>Keep your reference number for your records.</p>'
    + poster
    + '</div>';
}

function htmlRows_(pairs) {
  return pairs.map(function (pair) {
    return '<tr><td style="padding:4px 12px 4px 0;color:#555555;">' + escapeHtml_(pair[0]) + '</td>'
      + '<td style="padding:4px 0;"><strong>' + escapeHtml_(pair[1]) + '</strong></td></tr>';
  }).join('');
}

// Default addresses plus ORGANIZER_EMAIL (comma-separated), lowercased, no duplicates.
function organizerRecipients_() {
  var configured = getProperty_('ORGANIZER_EMAIL').split(',');
  var all = DEFAULT_ORGANIZER_EMAILS.concat(configured).map(function (address) {
    return address.trim().toLowerCase();
  }).filter(function (address) {
    return address.length > 0;
  });
  return all.filter(function (address, i) {
    return all.indexOf(address) === i;
  });
}

function sendOrganizerEmail_(ref, player, stored) {
  var sheetUrl = getSpreadsheet_().getUrl();
  var pairs = [
    ['Reference', ref],
    ['Name', player.fullName],
    ['Email', player.email],
    ['Phone', player.phone],
    ['Municipality', player.municipality],
    ['Barangay', player.barangay],
    ['Category', CATEGORIES[player.category]],
    ['Partner', player.partnerName]
  ].concat(clubPairs_(player), [
    ['Shirt size', player.shirtSize],
    ['Payment ref', player.paymentRef],
    ['Receipt', stored.receiptUrl],
    ['Valid ID', stored.validIdUrl],
    ['Sheet', sheetUrl]
  ]);
  var note = 'Status: Pending check. The receipt checker will process it.';
  var text = pairs.map(function (pair) {
    return pair[0] + ': ' + pair[1];
  }).join('\n') + '\n\n' + note;
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1d1d1d;">'
    + '<h3 style="margin:0 0 12px;">New registration</h3>'
    + '<table style="border-collapse:collapse;">' + htmlRows_(pairs) + '</table>'
    + '<p>' + escapeHtml_(note) + '</p></div>';
  MailApp.sendEmail({
    to: organizerRecipients_().join(', '),
    subject: 'New registration ' + ref + ' (' + CATEGORIES[player.category] + ')',
    body: text,
    htmlBody: html,
    name: SENDER_NAME
  });
}

// ---------------------------------------------------------------------------
// Category tabs (derived from Registrations, rebuilt after each change)
// ---------------------------------------------------------------------------

function rebuildTabs() {
  rebuildCategoryTabs_();
}

function rebuildTabsSafely_(onlyKey) {
  try {
    rebuildCategoryTabs_(onlyKey);
  } catch (err) {
    Logger.log('Category tab rebuild failed: ' + err);
  }
}

// onlyKey: rebuild one category tab. Omitted: rebuild all six.
function rebuildCategoryTabs_(onlyKey) {
  var ss = getSpreadsheet_();
  var rows = readRows_(getSheet_());
  Object.keys(CATEGORY_TABS).filter(function (key) {
    return !onlyKey || key === onlyKey;
  }).forEach(function (key) {
    var name = CATEGORY_TABS[key];
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var values = buildPairs_(rows, key);
    sheet.clearContents();
    sheet.getRange(1, 1, values.length, PAIR_HEADERS.length).setValues(values);
    sheet.setFrozenRows(1);
  });
}

// Pure. Returns the tab values: a header row, then one row per pair or waiting player.
function buildPairs_(rows, categoryKey) {
  var label = CATEGORIES[categoryKey];
  var players = rows.filter(function (row) {
    return row.Category === label && row.Status !== REJECTED_STATUS;
  });
  var used = players.map(function () {
    return false;
  });
  // partnerOf[i] = index of the partner, exact[i] = both names match
  var partnerOf = players.map(function () {
    return -1;
  });
  var exact = players.map(function () {
    return false;
  });
  // Exact pairs first, so a one-way match cannot take a player whose exact partner comes later.
  [true, false].forEach(function (mutual) {
    players.forEach(function (player, i) {
      if (used[i]) {
        return;
      }
      used[i] = true;
      var j = findPartner_(players, used, i, mutual);
      if (j >= 0) {
        used[j] = true;
        partnerOf[i] = j;
        partnerOf[j] = i;
        exact[i] = exact[j] = mutual;
      } else {
        used[i] = false;
      }
    });
  });
  var out = [PAIR_HEADERS];
  var written = players.map(function () {
    return false;
  });
  players.forEach(function (player, i) {
    if (written[i]) {
      return;
    }
    written[i] = true;
    var j = partnerOf[i];
    if (j >= 0) {
      written[j] = true;
    }
    out.push(pairRow_(out.length, player, j >= 0 ? players[j] : null, exact[i]));
  });
  return out;
}

// mutual = true: both names match. mutual = false: either name matches.
function findPartner_(players, used, index, mutual) {
  var me = players[index];
  for (var j = 0; j < players.length; j++) {
    if (used[j]) {
      continue;
    }
    var other = players[j];
    var namesOther = pairName_(me['Partner Name']) === pairName_(other['Full Name']);
    var namedByOther = pairName_(other['Partner Name']) === pairName_(me['Full Name']);
    if (mutual ? namesOther && namedByOther : namesOther || namedByOther) {
      return j;
    }
  }
  return -1;
}

function pairRow_(pairNo, first, second, exact) {
  var status = 'Complete';
  var note = '';
  if (!second) {
    status = 'Waiting for partner';
    note = 'Named partner: ' + first['Partner Name'];
  } else if (!exact) {
    note = PARTNER_NOTE;
  }
  return [pairNo, status]
    .concat(playerCells_(first), playerCells_(second))
    .concat([safeCell_(note)]);
}

function playerCells_(row) {
  if (!row) {
    return ['', '', '', '', '', '', ''];
  }
  return [
    safeCell_(row['Full Name']),
    row.Ref,
    row.Status,
    safeCell_(row['Club Name']),
    textCell_(String(row.Phone).replace(/^'/, '')),
    safeCell_(row.Email),
    row['Shirt Size']
  ];
}

// ---------------------------------------------------------------------------
// Admin: pending, verify, refs
// ---------------------------------------------------------------------------

function listPending_() {
  var rows = readRows_(getSheet_());
  var pending = rows.filter(function (row) {
    return row.Status === PENDING_STATUS;
  }).slice(0, PENDING_BATCH_SIZE);
  return { ok: true, items: pending.map(pendingItem_) };
}

function pendingItem_(row) {
  var blob = DriveApp.getFileById(row['Receipt File ID']).getBlob();
  return {
    ref: row.Ref,
    row: row._row,
    fullName: row['Full Name'],
    email: row.Email,
    category: row.Category,
    paymentRef: String(row['Payment Ref (player)'] ?? '').replace(/^'/, ''),
    submittedAt: String(row['Submitted At']),
    fileName: blob.getName(),
    mimeType: blob.getContentType(),
    base64: Utilities.base64Encode(blob.getBytes())
  };
}

function verifyRegistration_(ref, result) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    throw invalid_('Reference is not valid.', 'ref');
  }
  if (!result || typeof result !== 'object') {
    throw invalid_('Result is missing.', 'result');
  }
  if (VERDICTS.indexOf(result.verdict) < 0) {
    throw invalid_('Verdict must be Verified, Needs review, or Suspect.', 'result.verdict');
  }
  var sheet = getSheet_();
  var row = readRows_(sheet).find(function (r) {
    return r.Ref === ref;
  });
  if (!row) {
    throw apiError_('NOT_FOUND', 'No registration has this reference.');
  }
  updateRow_(sheet, row._row, {
    'Status': result.verdict,
    'Verdict': result.verdict,
    'OCR Amount': safeCell_(result.amount),
    'OCR Reference No': textCell_(result.referenceNo),
    'OCR Txn Date': safeCell_(result.txnDate),
    'OCR Sender': safeCell_(result.sender),
    'OCR Recipient': safeCell_(result.recipient),
    'Tamper Score': toNumberOrBlank_(result.tamperScore),
    'Flags': safeCell_(joinFlags_(result.flags)),
    'Image Hash': safeCell_(result.imageHash),
    'Checked At': safeCell_(result.checkedAt || formatNow_()),
    'OCR Text': safeCell_(String(result.ocrText || '').slice(0, OCR_TEXT_MAX))
  });
  var categoryKey = Object.keys(CATEGORIES).find(function (key) {
    return CATEGORIES[key] === row.Category;
  });
  // A row with an unknown category label still gets checked; then all tabs are rebuilt.
  rebuildTabsSafely_(categoryKey);
  return { ok: true, ref: ref, status: result.verdict };
}

function toNumberOrBlank_(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  var n = Number(value);
  return isFinite(n) ? n : '';
}

function joinFlags_(flags) {
  return Array.isArray(flags) ? flags.map(String).join('; ') : '';
}

function listRefs_() {
  var refs = readRows_(getSheet_()).filter(function (row) {
    return !!row['Checked At'];
  }).map(function (row) {
    return {
      ref: row.Ref,
      referenceNo: String(row['OCR Reference No'] ?? '').replace(/^'/, ''),
      imageHash: String(row['Image Hash'] ?? '')
    };
  });
  return { ok: true, refs: refs };
}
