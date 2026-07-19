const values = [3, 1, 2]

// This fixture must fail under the browser ES2022 lib. It proves that a
// TypeScript upgrade cannot silently make ES2023 built-ins available here.
export const sortedValues = values.toSorted()
