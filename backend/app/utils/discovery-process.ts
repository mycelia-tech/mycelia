/** Drain and reap one isolated manifest process with bounded time and output. */
export async function readDiscoveryProcess(
  command: Deno.Command,
  { timeoutMs = 60_000, maxOutputBytes = 1_048_576 }: {
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<string> {
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
  ) {
    throw new Error("Discovery process limits must be positive integers");
  }
  const child = command.spawn();
  let exited = false;
  const statusPromise = child.status.then((status) => {
    exited = true;
    return status;
  });
  let failure: Error | undefined;
  let outputBytes = 0;
  const stop = (message: string) => {
    if (failure) return;
    failure = new Error(message);
    if (exited) return;
    try {
      // Import code may ignore SIGTERM. Discovery owns this short-lived child.
      child.kill("SIGKILL");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  const timer = setTimeout(
    () => stop(`Manifest discovery timed out after ${timeoutMs} ms`),
    timeoutMs,
  );
  const read = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        stop(`Manifest discovery exceeded ${maxOutputBytes} output bytes`);
      }
      if (keep && !failure) text += decoder.decode(chunk, { stream: true });
    }
    return text + (keep ? decoder.decode() : "");
  };
  const stdout = read(child.stdout, true);
  const stderr = read(child.stderr, false);
  try {
    const [output, , status] = await Promise.all([
      stdout,
      stderr,
      statusPromise,
    ]);
    if (failure) throw failure;
    if (!status.success) {
      // Module logs can contain credentials; do not copy stdout/stderr to logs.
      throw new Error(
        `Manifest discovery process exited with code ${status.code}`,
      );
    }
    return output;
  } catch (error) {
    stop("Manifest discovery could not read child output");
    await Promise.allSettled([stdout, stderr, statusPromise]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
