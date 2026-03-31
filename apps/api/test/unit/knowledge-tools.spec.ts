import { describe, it, expect } from "vitest";
import { getOrgContextToolSchema } from "../../src/services/org-context-tools";
import { getKnowledgeBaseToolSchema } from "../../src/services/kb-tools";

describe("Knowledge Query Tool Schemas", () => {
  describe("orgContextQuery", () => {
    it("returns valid tool schema", () => {
      const schema = getOrgContextToolSchema() as {
        type: string;
        function: {
          name: string;
          description: string;
          parameters: {
            type: string;
            properties: Record<string, unknown>;
            required: string[];
          };
        };
      };

      expect(schema.type).toBe("function");
      expect(schema.function.name).toBe("orgContextQuery");
      expect(schema.function.description).toContain("firm documents");
    });

    it("has correct operations enum", () => {
      const schema = getOrgContextToolSchema() as {
        function: {
          parameters: {
            properties: {
              operation: { enum: string[] };
            };
          };
        };
      };

      const ops = schema.function.parameters.properties.operation.enum;
      expect(ops).toContain("list");
      expect(ops).toContain("search");
      expect(ops).toContain("getDocument");
    });

    it("requires operation parameter", () => {
      const schema = getOrgContextToolSchema() as {
        function: { parameters: { required: string[] } };
      };

      expect(schema.function.parameters.required).toContain("operation");
    });
  });

  describe("knowledgeBaseQuery", () => {
    it("returns valid tool schema", () => {
      const schema = getKnowledgeBaseToolSchema() as {
        type: string;
        function: {
          name: string;
          description: string;
          parameters: {
            type: string;
            properties: Record<string, unknown>;
            required: string[];
          };
        };
      };

      expect(schema.type).toBe("function");
      expect(schema.function.name).toBe("knowledgeBaseQuery");
      expect(schema.function.description).toContain("Knowledge Base");
    });

    it("has correct operations enum", () => {
      const schema = getKnowledgeBaseToolSchema() as {
        function: {
          parameters: {
            properties: {
              operation: { enum: string[] };
            };
          };
        };
      };

      const ops = schema.function.parameters.properties.operation.enum;
      expect(ops).toContain("search");
      expect(ops).toContain("listCategories");
    });

    it("has filter parameters", () => {
      const schema = getKnowledgeBaseToolSchema() as {
        function: {
          parameters: {
            properties: Record<string, unknown>;
          };
        };
      };

      const props = schema.function.parameters.properties;
      expect(props).toHaveProperty("category");
      expect(props).toHaveProperty("jurisdiction");
      expect(props).toHaveProperty("practiceType");
    });
  });
});
