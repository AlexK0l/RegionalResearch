const promptingGuideSummary = `
You must build prompts using these distilled rules from the provided Prompting Guide:

1. Control verbosity and output shape explicitly.
- Keep the final prompt concise but complete.
- Prefer short sections, crisp bullets, and direct language.
- Avoid bloated narrative instructions.

2. Prevent scope drift.
- Implement exactly and only what the user's note asks for.
- Do not invent extra features, UX embellishments, side tasks, or stylistic flourishes.
- If anything is ambiguous, choose the simplest valid interpretation.

3. Handle ambiguity carefully.
- Never fabricate exact facts, figures, URLs, or assumptions.
- When essential personalized data is missing, insert placeholders only where truly necessary using {{placeholder_name}}.
- Do not convert universal quality rules, structure, formatting standards, or method instructions into placeholders.

4. Preserve prompt usability.
- Produce a reusable prompt template, not the direct answer to the user's underlying task.
- The prompt must contain a clear role, task, context, constraints, and expected output shape when those elements are supported by the note.
- The prompt must be ready to paste into another LLM.

5. Quality bar.
- The prompt should be clear, concrete, structured, and easy for another model to follow.
- The prompt must remain grounded in the user's note.
- Avoid unnecessary placeholders, duplicated constraints, vague wording, and contradictory instructions.
`;

module.exports = { promptingGuideSummary };
