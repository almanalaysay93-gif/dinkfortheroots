/**
 * Dink for the Roots registration backend.
 * Google Apps Script, V8. Bound to the registration Sheet, or standalone with SHEET_ID.
 * API contract: ORCHESTRATOR.md in the project root.
 */

var SHEET_NAME = 'Registrations';
// Used when the script is standalone (not opened from the Sheet's Extensions menu).
var SHEET_ID = '1nU4mEsdvNxyiP4gskgR2rZKjcnXwO9tcI4cob9Cv2YA';
var RECEIPT_FOLDER_NAME = 'Dink for the Roots Receipts';
var SENDER_NAME = 'Dink for the Roots';
var TIME_ZONE = 'Asia/Manila';
var DEFAULT_ORGANIZER_EMAIL = 'ibanezdianarose9@gmail.com';
var EVENT_DATE_TEXT = 'Saturday, December 5, 2026';
var EVENT_VENUE_TEXT = 'Pickle Park, Roxas Extension, Digos City';
var CATEGORY_CAP = 36;
var LOCK_WAIT_MS = 20000;
var MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
var MAX_BASE64_CHARS = Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 + 4;
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
var RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

var CATEGORIES = {
  'novice-mens': "Novice Men's Doubles",
  'novice-womens': "Novice Women's Doubles",
  'novice-mixed': 'Novice Mixed Doubles',
  'rookie': 'Rookie Doubles'
};

var SHIRT_SIZES = ['K8', 'K10', 'K12', 'K14', 'K16', 'K18', 'K20', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

var MUNICIPALITIES = [
  'Digos City', 'Bansalan', 'Hagonoy', 'Kiblawan', 'Magsaysay',
  'Malalag', 'Matanao', 'Padada', 'Santa Cruz', 'Sulop'
];

var HEADERS = [
  'Ref', 'Submitted At', 'Status', 'Full Name', 'Email', 'Phone', 'Municipality',
  'Barangay', 'Category', 'Partner Name', 'Shirt Size', 'Payment Ref (player)',
  'Receipt File ID', 'Receipt URL', 'Verdict', 'OCR Amount', 'OCR Reference No',
  'OCR Txn Date', 'OCR Sender', 'OCR Recipient', 'Tamper Score', 'Flags',
  'Image Hash', 'Checked At', 'OCR Text', 'Player Email Sent', 'Organizer Email Sent'
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
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else {
    var current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (!sameHeaders_(current)) {
      throw new Error('Row 1 of ' + SHEET_NAME + ' does not match the contract header. Fix it, then run setup again.');
    }
  }
  sheet.setFrozenRows(1);

  var props = PropertiesService.getScriptProperties();
  ensureReceiptFolder_(props);
  if (!props.getProperty('ORGANIZER_EMAIL')) {
    props.setProperty('ORGANIZER_EMAIL', DEFAULT_ORGANIZER_EMAIL);
  }
  if (!props.getProperty('POSTER_URL')) {
    props.setProperty('POSTER_URL', '');
  }
  if (!props.getProperty('ADMIN_KEY')) {
    props.setProperty('ADMIN_KEY', Utilities.getUuid());
  }
  Logger.log('ADMIN_KEY: ' + props.getProperty('ADMIN_KEY'));
  Logger.log('Setup complete. Set POSTER_URL in Project Settings > Script properties.');
}

function sameHeaders_(current) {
  return HEADERS.every(function (name, i) {
    return current[i] === name;
  });
}

function ensureReceiptFolder_(props) {
  if (props.getProperty('RECEIPT_FOLDER_ID')) {
    return;
  }
  var folders = DriveApp.getFoldersByName(RECEIPT_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(RECEIPT_FOLDER_NAME);
  props.setProperty('RECEIPT_FOLDER_ID', folder.getId());
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
// Slots
// ---------------------------------------------------------------------------

function getSlots_() {
  var rows = readRows_(getSheet_());
  var slots = {};
  Object.keys(CATEGORIES).forEach(function (key) {
    slots[key] = { taken: countCategory_(rows, key), cap: CATEGORY_CAP };
  });
  return { ok: true, open: true, slots: slots };
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

function normalizeName_(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
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

function validateReceipt_(input) {
  var r = input && typeof input === 'object' ? input : {};
  var fileName = requireText_(r.fileName, 1, 120, 'receipt.fileName', 'Receipt file name');
  if (RECEIPT_MIME_TYPES.indexOf(r.mimeType) < 0) {
    throw invalid_('Receipt must be a JPEG, PNG, or WebP image.', 'receipt.mimeType');
  }
  if (typeof r.base64 !== 'string' || r.base64.length === 0) {
    throw invalid_('Receipt file is missing.', 'receipt.base64');
  }
  if (r.base64.length > MAX_BASE64_CHARS) {
    throw invalid_('Receipt is larger than 5 MB.', 'receipt.base64');
  }
  var bytes;
  try {
    bytes = Utilities.base64Decode(r.base64);
  } catch (err) {
    throw invalid_('Receipt file is not valid base64.', 'receipt.base64');
  }
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw invalid_('Receipt is larger than 5 MB.', 'receipt.base64');
  }
  if (sniffMime_(bytes) !== r.mimeType) {
    throw invalid_('Receipt content does not match its file type.', 'receipt.mimeType');
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
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
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
  if (body.consent !== true) {
    throw invalid_('Consent is required.', 'consent');
  }
  var player = validatePlayer_(body.player);
  var receipt = validateReceipt_(body.receipt);
  var stored = withLock_(function () {
    return storeRegistration_(player, receipt);
  });
  if (stored.duplicate) {
    return { ok: true, duplicate: true, ref: stored.ref };
  }
  var status = sendRegistrationEmails_(stored.ref, player, stored.receiptUrl);
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

function storeRegistration_(player, receipt) {
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
  var file = saveReceipt_(ref, receipt);
  sheet.appendRow(rowFromObject_(buildRecord_(ref, player, file)));
  return { duplicate: false, ref: ref, row: sheet.getLastRow(), receiptUrl: file.getUrl() };
}

function buildRecord_(ref, player, file) {
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
    'Shirt Size': player.shirtSize,
    'Payment Ref (player)': textCell_(player.paymentRef),
    'Receipt File ID': file.getId(),
    'Receipt URL': file.getUrl()
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

function saveReceipt_(ref, receipt) {
  var folder = getReceiptFolder_();
  var name = ref + '-' + sanitizeFileName_(receipt.fileName);
  var blob = Utilities.newBlob(receipt.bytes, receipt.mimeType, name);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return file;
}

// ---------------------------------------------------------------------------
// Emails (sent after the lock is released)
// ---------------------------------------------------------------------------

function sendRegistrationEmails_(ref, player, receiptUrl) {
  return {
    player: sendSafely_(function () {
      sendPlayerEmail_(ref, player);
    }),
    organizer: sendSafely_(function () {
      sendOrganizerEmail_(ref, player, receiptUrl);
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

function playerEmailText_(ref, player, posterAttached) {
  var lines = [
    'Hi ' + player.fullName + ',',
    '',
    'Thank you for registering for Dink for the Roots, a pickleball fundraising tournament for Indigenous communities.',
    '',
    'Reference: ' + ref,
    'Category: ' + CATEGORIES[player.category],
    'Partner: ' + player.partnerName,
    'Shirt size: ' + player.shirtSize,
    'Date: ' + EVENT_DATE_TEXT,
    'Venue: ' + EVENT_VENUE_TEXT,
    '',
    'Your payment receipt will be checked. If anything is wrong with it, we will email you.',
    'Keep your reference number for your records.'
  ];
  if (posterAttached) {
    lines.push('', 'The event poster is attached to this email.');
  }
  return lines.join('\n');
}

function playerEmailHtml_(ref, player, posterAttached) {
  var rows = htmlRows_([
    ['Reference', ref],
    ['Category', CATEGORIES[player.category]],
    ['Partner', player.partnerName],
    ['Shirt size', player.shirtSize],
    ['Date', EVENT_DATE_TEXT],
    ['Venue', EVENT_VENUE_TEXT]
  ]);
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

function sendOrganizerEmail_(ref, player, receiptUrl) {
  var to = getProperty_('ORGANIZER_EMAIL') || DEFAULT_ORGANIZER_EMAIL;
  var sheetUrl = getSpreadsheet_().getUrl();
  var pairs = [
    ['Reference', ref],
    ['Name', player.fullName],
    ['Email', player.email],
    ['Phone', player.phone],
    ['Municipality', player.municipality],
    ['Barangay', player.barangay],
    ['Category', CATEGORIES[player.category]],
    ['Partner', player.partnerName],
    ['Shirt size', player.shirtSize],
    ['Payment ref', player.paymentRef],
    ['Receipt', receiptUrl],
    ['Sheet', sheetUrl]
  ];
  var note = 'Status: Pending check. The receipt checker will process it.';
  var text = pairs.map(function (pair) {
    return pair[0] + ': ' + pair[1];
  }).join('\n') + '\n\n' + note;
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1d1d1d;">'
    + '<h3 style="margin:0 0 12px;">New registration</h3>'
    + '<table style="border-collapse:collapse;">' + htmlRows_(pairs) + '</table>'
    + '<p>' + escapeHtml_(note) + '</p></div>';
  MailApp.sendEmail({
    to: to,
    subject: 'New registration ' + ref + ' (' + CATEGORIES[player.category] + ')',
    body: text,
    htmlBody: html,
    name: SENDER_NAME
  });
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
