-- Persists a user message's extracted document text (PDF OCR, DOCX/XLSX parsing, plain-text
-- decode — see backend extractDocumentText()) so a later turn can recall an uploaded file's
-- content without re-uploading it. Previously this was recomputed fresh every turn from the raw
-- attachments array, which only ever carried the CURRENT turn's attachments — a follow-up
-- message with no attachment had nothing to extract from, so the model had no memory of a file's
-- actual content beyond whatever it happened to say about it in a prior reply. Storing it once at
-- upload time also avoids re-running Sarvam's paid OCR call on every subsequent turn.
alter table public.messages
  add column if not exists extracted_text text;
