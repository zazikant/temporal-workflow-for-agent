import { Connection } from "@temporalio/client";

export async function waitForServer(maxRetries = 10, delayMs = 3000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const conn = await Connection.connect({ address: "localhost:7233" });
      await conn.workflowService.listNamespaces({});
      conn.close();
      console.log("Connected to Temporal server!");
      return;
    } catch {
      console.log(`Waiting for server... (attempt ${i + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error("Could not connect to Temporal server");
}