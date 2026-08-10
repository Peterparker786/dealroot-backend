// ============================================================
// GOOGLE SHEETS + DRIVE SYNC
// When a Tryout member submits a purchase form, the proof is
// uploaded to a Google Drive folder and a row is appended to the
// owner's Google Sheet (Profile Name, Order Id, Order Date, Order
// Amount, Product Name, Drive link).
//
// Setup (one time):
//   1. Google Cloud Console → create a project
//   2. Enable "Google Sheets API" + "Google Drive API"
//   3. Create a Service Account → download the JSON key
//   4. Share the target Google Sheet with the service account email
//      (Editor), and share a Drive folder too (so uploads land there)
//   5. Add to .env:
//      GOOGLE_SERVICE_ACCOUNT_JSON=<full JSON or path to key file>
//      GOOGLE_SHEET_ID=<id from the sheet URL>
//      GOOGLE_DRIVE_FOLDER_ID=<id of the upload folder>
// If any of these are missing the sync is silently skipped and the
// normal Cloudinary + email flow still works.
// ============================================================

const { google } = require("googleapis");

let cachedAuth = null;
let cachedSheets = null;
let cachedDrive = null;
let disabled = false;

function resolveCredentials() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;

  // Accept either the raw JSON or a path to a JSON key file.
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  try {
    // eslint-disable-next-line global-require
    return require("path").resolve(raw);
  } catch {
    return null;
  }
}

function getClients() {
  if (disabled) return null;
  if (cachedAuth) return { sheets: cachedSheets, drive: cachedDrive };

  const credentials = resolveCredentials();

  if (!credentials) {
    disabled = true;
    return null;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials:
        typeof credentials === "string" ? undefined : credentials,
      keyFile: typeof credentials === "string" ? credentials : undefined,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file",
      ],
    });

    cachedAuth = auth;
    cachedSheets = google.sheets({ version: "v4", auth });
    cachedDrive = google.drive({ version: "v3", auth });
    return { sheets: cachedSheets, drive: cachedDrive };
  } catch (error) {
    console.error("Google sync init failed:", error.message);
    disabled = true;
    return null;
  }
}

const extOf = (mime) => {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[mime] || "png";
};

// Uploads a screenshot buffer to the configured Drive folder and makes
// it viewable by anyone with the link. Returns { fileId, webViewLink }.
async function uploadScreenshotToDrive(buffer, filename, mimetype) {
  const clients = getClients();
  if (!clients) return null;
  const folderId = String(process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  if (!folderId) return null;

  const fileMime = String(mimetype || "image/png").trim() || "image/png";

  const file = await clients.drive.files.create({
    requestBody: {
      name: filename || ("purchase-" + Date.now() + "." + extOf(fileMime)),
      parents: [folderId],
    },
    media: {
      mimeType: fileMime,
      body: buffer,
    },
    fields: "id,webViewLink",
  });

  // Anyone with the link can view (needed so the admin panel preview
  // and the sheet link work without a login).
  try {
    await clients.drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });
  } catch (error) {
    console.error("Drive permission set failed:", error.message);
  }

  const fileId = file.data.id;

  return {
    fileId,
    webViewLink: file.data.webViewLink,
    // Direct image URL (no Google Drive UI) — works inside <img> tags and
    // lightbox previews without any login.
    imageUrl:
      "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w1200",
  };
}

// Appends one row to the configured Google Sheet.
// values: array of cell values, in order.
async function appendRowToSheet(values) {
  const clients = getClients();
  if (!clients) return false;
  const sheetId = String(process.env.GOOGLE_SHEET_ID || "").trim();
  if (!sheetId) return false;

  const clean = (value) =>
    value === null || value === undefined ? "" : String(value);

  await clients.sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:G",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values.map(clean)],
    },
  });

  return true;
}

// Best-effort sync: never throws, never blocks the main flow.
async function syncPurchaseFormToGoogle({
  profileName,
  orderId,
  orderAmount,
  productName,
  phoneAtStore,
  orderDate,
  buffer,
  filename,
  mimetype,
}) {
  try {
    if (!process.env.GOOGLE_SHEET_ID && !process.env.GOOGLE_DRIVE_FOLDER_ID) {
      return null;
    }

    const drive = buffer
      ? await uploadScreenshotToDrive(buffer, filename, mimetype)
      : null;

    // Order number column = the phone number used at the marketplace
    // (kept as text so leading zeros survive), Order date = member-entered
    // marketplace order date, fallback to today.
    const orderDateStr = orderDate
      ? String(orderDate).trim()
      : new Date().toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "2-digit",
        });

    const row = [
      profileName || "",
      orderId || "",
      orderDateStr,
      phoneAtStore ? "'" + String(phoneAtStore).trim() : "",
      productName || "",
      orderAmount || "",
      drive?.webViewLink || "",
    ];

    await appendRowToSheet(row);

    return {
      driveFileId: drive?.fileId || "",
      driveUrl: drive?.webViewLink || "",
      driveImageUrl: drive?.imageUrl || "",
    };
  } catch (error) {
    console.error("Google sync failed (continuing):", error.message);
    return null;
  }
}

module.exports = {
  uploadScreenshotToDrive,
  appendRowToSheet,
  syncPurchaseFormToGoogle,
};
