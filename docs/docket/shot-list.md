# Docket Case Study Shot List

## App Screenshots

| #   | Shot                        | Section             | Notes                                                 |
| --- | --------------------------- | ------------------- | ----------------------------------------------------- |
| 1   | Hero shot                   | Opening             | Web chat with process log sidebar visible             |
| 2   | Process log panel           | On Interfaces       | Real-time sources being read (KB chunks, org context) |
| 3   | Confirmation modal          | Commanding Clio     | Bot asking "Add this to calendar?" with approve/deny  |
| 4   | Org context upload          | Org Context Uploads | File upload interface with document list              |
| 5   | Slack fundraising assistant | The Pivot           | First version conversation showing API calls working  |

---

## Designed Graphics (Figma)

| #   | Shot                   | Section              | Notes                                              |
| --- | ---------------------- | -------------------- | -------------------------------------------------- |
| 6   | Three-source diagram   | Hypothesis           | KB + Org Context + CRM → Chat Interface            |
| 7   | Architecture overview  | Cloudflare Workers   | Channels → Worker → DO → Storage → AI → Clio       |
| 8   | RAG + upload pipeline  | The Knowledge Base   | Upload → Parse → Chunk → Embed → Vectorize → Prompt |
| 9   | Storage layer diagram  | Storage Architecture | D1, R2, Vectorize, DO SQLite relationships         |

---

## External Screenshots

| #   | Shot           | Section     | Notes                               |
| --- | -------------- | ----------- | ----------------------------------- |
| 10  | Clio dashboard | Why Lawyers | Show the CRM Docket integrates with |

---

## Notes

- **Process log is the differentiator**: #2 is the most important screenshot
- **Mermaid stays**: Technical Flow section keeps its mermaid—#7 is a cleaner designed version for earlier in the doc
- **RAG + upload combined**: Same pipeline, one diagram
