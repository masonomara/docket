export const R2Paths = {
  orgDoc(orgId: string, fileId: string): string {
    return `orgs/${orgId}/docs/${fileId}`;
  },

  auditLogPrefix(
    orgId: string,
    year: number,
    month: number,
    day?: number
  ): string {
    const m = month.toString().padStart(2, "0");
    if (day)
      return `orgs/${orgId}/audit/${year}/${m}/${day
        .toString()
        .padStart(2, "0")}/`;
    return `orgs/${orgId}/audit/${year}/${m}/`;
  },

  archivedConversation(orgId: string, conversationId: string): string {
    return `orgs/${orgId}/conversations/${conversationId}.json`;
  },
};
