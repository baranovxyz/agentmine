export const ExitCode = {
  SUCCESS: 0,
  PARTIAL: 1,
  USER_ERROR: 2,
  SYSTEM_ERROR: 3,
  TRANSIENT: 4,
  CONFLICT: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeForCategory(
  category: "user" | "system" | "transient",
): ExitCodeValue {
  switch (category) {
    case "user":
      return ExitCode.USER_ERROR;
    case "system":
      return ExitCode.SYSTEM_ERROR;
    case "transient":
      return ExitCode.TRANSIENT;
  }
}
