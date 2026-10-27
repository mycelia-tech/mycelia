export type Fixture = {
  token: any;
  dependencies?: any[];
  factory?: (...args: any[]) => Promise<any> | any;
  teardown?: (setup: any) => Promise<void> | void;
};

/** Unwind only successful setup, in dependency order, retaining all failures. */
export async function runFixtureLifecycle(
  fixtures: Fixture[],
  dependencies: any[],
  testFn: (...args: any[]) => Promise<void> | void,
  finalize: () => void,
): Promise<void> {
  const resolved = new Map<any, any>();
  const created: Fixture[] = [];
  const errors: unknown[] = [];
  try {
    for (const fixture of fixtures) {
      const args = fixture.dependencies?.map((dep) => resolved.get(dep)) ?? [];
      resolved.set(fixture.token, await fixture.factory?.(...args));
      created.push(fixture);
    }
    await testFn(...dependencies.map((dep) => resolved.get(dep)));
  } catch (error) {
    errors.push(error);
  } finally {
    for (const fixture of created.reverse()) {
      try {
        await fixture.teardown?.(resolved.get(fixture.token));
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      finalize();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) {
    throw new AggregateError(errors, "Fixture setup/test/cleanup failed");
  }
}
