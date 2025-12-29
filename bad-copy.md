# Copywriting and Structure Update

## Analysis

Both screens suffer from the same issues:

1. **Over-explanation**: Users already know why they're here
2. **Technical jargon**: "Schema cache", "vector embeddings", "chunks"
3. **Redundant display**: Status shown in multiple places
4. **Buried actions**: Key functionality hidden behind informational sections

## Principles Applied

- Omit needless words (Strunk & White)
- Form follows function (primary action first)
- No technical jargon (users are lawyers, not engineers)
- Progressive disclosure (rare actions at bottom)

---

## Clio Screen

### Current Structure

```
Header: "Clio Connection" + status badge + connect/refresh button
↓
Connection Status (table: account status, schema cache)
↓
Schema Management (admin only) - refresh explanation + button
↓
"What Docket can do with Clio" (bullet list)
↓
"Security" (bullet list)
↓
Danger Zone - disconnect
```

### Problems

1. **Redundant status**: Badge in header AND status table show same info
2. **Unnecessary sections**: "What Docket can do" and "Security" are defensive copy. Users who connect Clio already understand the purpose. This info belongs in marketing/docs, not the settings page.
3. **Schema jargon**: Users don't know what "schema cache" means or why they'd refresh it

### Proposed Structure

```
Header: "Clio" + status badge + primary action button
↓
(If not connected: nothing else needed)
↓
(If connected, admin only):
Schema section - simple explanation of when to refresh
↓
Danger Zone - disconnect
```

### Proposed Copy

**Page Title:** Clio

**Subtitle:** Connect your Clio account to query matters, contacts, and calendar data.

**Not Connected State:**

- Status badge: "Not Connected"
- Primary button: "Connect to Clio"
- (No other sections needed)

**Connected State:**

- Status badge: "Connected"
- Button: "Reconnect" (for re-auth if needed)

**Schema Section (admin only, when connected):**

- Title: "Sync Clio Configuration"
- Description: "If you've added custom fields or changed your Clio setup, sync to update Docket."
- Button: "Sync Now"
- (Show last sync date if available)

**Danger Zone:**

- Title: "Disconnect Clio"
- Description: "Revokes Docket's access. You can reconnect anytime."
- Button: "Disconnect"

### What to Remove

- "Connection Status" table (redundant with badge)
- "What Docket can do with Clio" section (belongs in onboarding/marketing)
- "Security" section (belongs in privacy policy or help docs)
- Term "schema" (replace with "sync" or "configuration")

---

## Org Context Screen

### Current Structure

```
Header: "Org Context" + subtitle
↓
Info banner: "Upload procedures, templates, and policies. Avoid sensitive client data."
↓
Upload Documents section (drag/drop)
↓
Manage Documents table (filename, size, chunks, date, actions)
↓
"How Org Context works" (numbered list explaining vectors)
```

### Problems

1. **Technical jargon**: "Chunks" column means nothing to users
2. **Unnecessary section**: "How Org Context works" explains implementation details users don't need
3. **Title unclear**: "Org Context" is internal terminology

### Proposed Structure

```
Header: "Firm Documents" + subtitle (incorporates the warning)
↓
Upload section (drag/drop)
↓
Documents table (simplified columns)
```

### Proposed Copy

**Page Title:** Firm Documents

**Subtitle:** Upload internal procedures and policies. Docket uses these to answer questions. Avoid client data.

**Upload Section:**

- Title: Remove section title (upload box speaks for itself)
- Drop zone: "Drop file or click to upload"
- Hint: "PDF, Word, Excel, or text files (max 25MB)"

**Documents Table:**

- Columns: Filename | Size | Uploaded | (Delete button)
- Remove "Chunks" column

### What to Remove

- Info banner (merged into subtitle)
- "Upload Documents" section header (obvious from context)
- "Chunks" column (technical, meaningless to users)
- "How Org Context works" section entirely (implementation detail)

---

## Implementation Checklist

### Clio Screen (`org.clio.tsx`)

- [ ] Change page title from "Clio Connection" to "Clio"
- [ ] Update subtitle to include purpose (query matters, contacts, calendar)
- [ ] Remove "Connection Status" table section
- [ ] Rename "Schema Management" to "Sync Clio Configuration"
- [ ] Change "Refresh Schema" button to "Sync Now"
- [ ] Remove "What Docket can do with Clio" section
- [ ] Remove "Security" section
- [ ] Simplify Danger Zone description

### Org Context Screen (`org.context.tsx`)

- [ ] Change page title from "Org Context" to "Firm Documents"
- [ ] Merge warning into subtitle
- [ ] Remove info banner section
- [ ] Remove "Upload Documents" section header
- [ ] Remove "Chunks" column from table
- [ ] Remove "How Org Context works" section
