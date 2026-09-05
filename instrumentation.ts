/** Next.js calls register() once per server start. */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { startBackgroundJobs } = await import("./src/server/jobs");
    startBackgroundJobs();
  }
}
