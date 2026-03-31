import clioParams from "../generated/clio-params.json";

type ClioObjectType = keyof typeof clioParams.objects;
type ParamDefinition = { enum?: string[] };
type ParamMap = Record<string, ParamDefinition>;

export interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
  correctedValue?: string;
  invalidKey?: string;
}

const VALID_OBJECT_TYPES = Object.keys(clioParams.objects) as ClioObjectType[];

function getParamsForObjectType(objectType: string): ParamMap | undefined {
  if (!isValidObjectType(objectType)) {
    return undefined;
  }
  return clioParams.objects[objectType].params as ParamMap;
}

function isValidObjectType(objectType: string): objectType is ClioObjectType {
  return VALID_OBJECT_TYPES.includes(objectType as ClioObjectType);
}

function isValidEnumValue(
  allowedValues: string[],
  providedValue: unknown
): boolean {
  const normalizedProvided = String(providedValue).toLowerCase();
  const normalizedAllowed = allowedValues.map((v) => v.toLowerCase());
  return normalizedAllowed.includes(normalizedProvided);
}

export function validateFilters(
  objectType: string,
  filters?: Record<string, unknown>
): ValidationResult {
  const params = getParamsForObjectType(objectType);

  if (!params) {
    return {
      valid: false,
      error: `Unknown objectType "${objectType}".`,
      suggestion: `Valid types: ${VALID_OBJECT_TYPES.join(", ")}`,
    };
  }

  if (!filters) {
    return { valid: true };
  }

  for (const [filterKey, filterValue] of Object.entries(filters)) {
    const paramDef = params[filterKey];
    const allowedValues = paramDef?.enum;

    if (allowedValues && !isValidEnumValue(allowedValues, filterValue)) {
      return {
        valid: false,
        error: `Invalid ${filterKey}="${filterValue}".`,
        suggestion: `Valid values: ${allowedValues.join(", ")}`,
        correctedValue: allowedValues[0],
        invalidKey: filterKey,
      };
    }
  }

  if (objectType === "Task" && filters.assignee_id && !filters.assignee_type) {
    return {
      valid: false,
      error: "assignee_id requires assignee_type.",
      suggestion: "Add assignee_type: user or contact",
    };
  }

  return { valid: true };
}

export function normalizeFilters(
  objectType: string,
  filters?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!filters) {
    return undefined;
  }

  const params = getParamsForObjectType(objectType);
  if (!params) {
    return filters;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filters)) {
    const paramDef = params[key];
    const hasEnumConstraint = paramDef?.enum !== undefined;

    if (hasEnumConstraint && value !== undefined) {
      normalized[key] = String(value).toLowerCase();
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

export function getClioToolSchema(userRole: string): object {
  const isAdmin = userRole === "admin";
  const permissionNote = isAdmin
    ? "Create/update/delete require confirmation."
    : "Members: read only.";

  return {
    type: "function",
    function: {
      name: "clioQuery",
      description: `Query or modify Clio data. ${permissionNote}`,
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["read", "create", "update", "delete"],
          },
          objectType: {
            type: "string",
            enum: VALID_OBJECT_TYPES,
            description: "Clio object type. Use Activity for time entries.",
          },
          id: {
            type: "string",
            description: "Object ID (required for update/delete)",
          },
          filters: {
            type: "object",
            description: `Query filters. Examples:
- {"query": "Smith"} - text search
- {"status": "open"} - status filter
- {"matter_id": 123} - filter by matter
- {"user_id": 456} - filter by user
- {"created_since": "2024-01-01"} - date filter`,
          },
          data: {
            type: "object",
            description: "Data for create/update",
          },
        },
        required: ["operation", "objectType"],
      },
    },
  };
}
