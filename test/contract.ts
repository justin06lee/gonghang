/** The contract every test and fixture shares, the way two real components would. */
export type App = {
  "user.joined": { name: string };
  tick: void;
  note: string | undefined;

  sum: (input: { a: number; b: number }) => number;
  now: () => number;
  shout: (text: string) => Promise<string>;
  fail: (reason: string) => never;
};
