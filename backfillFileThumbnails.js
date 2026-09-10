/**
 * backfillFileThumbnails.js — Sam Cafe server, one-time script
 * ----------------------------------------------------------------
 * Generates first-page-preview thumbnails (see fileThumbnail.js) for
 * every EXISTING Documents record and staff ID proof / bonafide /
 * training certificate that predates the thumbnail feature.
 *
 * Why this is needed: the thumbnail generation added to the
 * POST/PUT/PATCH routes only runs going forward, when a file is
 * newly uploaded or an existing record is edited — it does not
 * retroactively touch rows that already exist in the database and
 * are never re-saved. Any document created before this feature
 * shipped will keep showing the generic icon fallback in
 * FilePreviewLink forever unless either (a) someone edits it once
 * (the PUT/PATCH routes now self-heal a missing thumbnail on any
 * edit — see documents.js / server.js), or (b) this script is run
 * once to backfill everything in bulk.
 *
 * USAGE
 * -----
 *   cd server
 *   node backfillFileThumbnails.js
 *
 * Requires the same .env (MONGO_URI) the main server uses, and the
 * same system dependency this whole feature needs: LibreOffice
 * installed and `soffice` on PATH for DOCX files (PDF thumbnails
 * work without it). Safe to re-run — it only processes records that
 * are missing a thumbnail, so a second run does nothing to records
 * the first run already handled (or intentionally left blank because
 * the file type isn't thumbnailable).
 *
 * This does NOT touch fileData/idProof/bonafide/certificate — it only
 * ever adds the *Thumbnail fields, so there's no risk to the
 * underlying files themselves even if this script needs to be
 * interrupted and re-run.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { Document } = require("./documents");
const { isThumbnailableDocument, generateFirstPageThumbnail } = require("./fileThumbnail");

// Mirrors getModel()'s schemaless model in server.js — this script
// intentionally doesn't require server.js itself (that file starts
// the HTTP server and a dozen other background jobs on load, which
// this one-off script has no business triggering).
const anySchema = new mongoose.Schema({}, { strict: false, timestamps: false, versionKey: false, id: false });
function getModel(collectionName) {
  return mongoose.models[collectionName] || mongoose.model(collectionName, anySchema, collectionName);
}

async function backfillDocuments() {
  const candidates = await Document.find({
    fileData: { $ne: "" },
    $or: [{ thumbnailData: { $exists: false } }, { thumbnailData: "" }],
  }).lean();

  console.log(`[backfill] documents: ${candidates.length} record(s) missing a thumbnail`);

  let rendered = 0;
  let skippedNotThumbnailable = 0;
  let failed = 0;

  for (const doc of candidates) {
    if (!isThumbnailableDocument(doc.fileType)) {
      skippedNotThumbnailable += 1;
      continue;
    }
    const thumbnailData = await generateFirstPageThumbnail(doc.fileType, doc.fileData);
    if (thumbnailData) {
      await Document.updateOne({ id: doc.id }, { $set: { thumbnailData } });
      rendered += 1;
      console.log(`[backfill]   ✓ ${doc.name || doc.id}`);
    } else {
      failed += 1;
      console.warn(`[backfill]   ✗ ${doc.name || doc.id} — render failed, left blank (will retry next run)`);
    }
  }

  console.log(
    `[backfill] documents done — rendered ${rendered}, skipped (not PDF/DOCX) ${skippedNotThumbnailable}, failed ${failed}`
  );
}

async function backfillStaff() {
  const StaffModel = getModel("staff");
  const flatFileFields = [
    { dataField: "idProof", typeField: "idProofType", thumbField: "idProofThumbnail" },
    { dataField: "bonafide", typeField: "bonafideType", thumbField: "bonafideThumbnail" },
  ];

  const staffList = await StaffModel.find({}).lean();
  console.log(`[backfill] staff: scanning ${staffList.length} record(s)`);

  let rendered = 0;
  let failed = 0;

  for (const staff of staffList) {
    const update = {};

    for (const { dataField, typeField, thumbField } of flatFileFields) {
      if (!staff[dataField] || staff[thumbField]) continue; // no file, or already has a thumbnail
      const fileType = staff[typeField] || sniffMimeFromDataUrl(staff[dataField]);
      if (!isThumbnailableDocument(fileType)) continue;
      const thumbnailData = await generateFirstPageThumbnail(fileType, staff[dataField]);
      if (thumbnailData) {
        update[thumbField] = thumbnailData;
        rendered += 1;
      } else {
        failed += 1;
        console.warn(`[backfill]   ✗ staff ${staff.name || staff.id} — ${dataField} render failed`);
      }
    }

    let trainingChanged = false;
    const training = Array.isArray(staff.training) ? staff.training : [];
    for (const entry of training) {
      if (!entry || !entry.certificate || entry.certificateThumbnail) continue;
      const fileType = entry.certificateType || sniffMimeFromDataUrl(entry.certificate);
      if (!isThumbnailableDocument(fileType)) continue;
      const thumbnailData = await generateFirstPageThumbnail(fileType, entry.certificate);
      if (thumbnailData) {
        entry.certificateThumbnail = thumbnailData;
        trainingChanged = true;
        rendered += 1;
      } else {
        failed += 1;
        console.warn(`[backfill]   ✗ staff ${staff.name || staff.id} — training certificate render failed`);
      }
    }
    if (trainingChanged) update.training = training;

    if (Object.keys(update).length > 0) {
      await StaffModel.updateOne({ id: staff.id }, { $set: update });
      console.log(`[backfill]   ✓ staff ${staff.name || staff.id}`);
    }
  }

  console.log(`[backfill] staff done — rendered ${rendered}, failed ${failed}`);
}

/** Reads the mime type out of a `data:<mime>;base64,...` URL, if present. */
function sniffMimeFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return "";
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match ? match[1] : "";
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("[backfill] MONGO_URI is not set — check your .env file.");
    process.exit(1);
  }

  console.log("[backfill] connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[backfill] connected");

  await backfillDocuments();
  await backfillStaff();

  await mongoose.disconnect();
  console.log("[backfill] done — disconnected");
}

main().catch((err) => {
  console.error("[backfill] fatal error:", err);
  process.exit(1);
});
