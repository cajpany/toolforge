// Stub repair: returns a minimal valid AssistantReply object with diagnostics
export function attemptRepair(errors: unknown) {
  const lastErrors = serializeErrors(errors);
  return {
    answer: '',
    citations: [],
    diagnostics: {
      error: 'schema_repair_failed',
      last_validator_errors: lastErrors,
    },
  };
}

function serializeErrors(errors: unknown) {
  try {
    // naive best-effort serialization
    if (Array.isArray(errors)) return errors;
    if (typeof errors === 'object' && errors) return errors;
    return String(errors);
  } catch {
    return 'unknown_error';
  }
}
