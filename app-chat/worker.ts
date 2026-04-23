import path from "path";
import { Connection, WorkflowClient } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { waitForServer } from "./wait-for-server";
import * as activities from "./activities";

const APP_DIR = "D:\\test\\app-chat";

async function run() {
  console.log("Waiting for Temporal server...");
  await waitForServer();

  console.log("Creating worker...");
  const worker = await Worker.create({
    workflowsPath: path.join(APP_DIR, "workflows", "build-app.ts"),
    activities,
    taskQueue: "build-app-queue",
  });

  console.log("Starting workflow...");
  const client = new WorkflowClient();
  const handle = await client.start("buildAppWorkflow", {
    taskQueue: "build-app-queue",
    args: ["Vite + React + TypeScript chatbot app"],
    workflowId: `build-app-${Date.now()}`,
  });

  console.log(`Workflow started: ${handle.workflowId}`);

  worker.run();
}

run().catch(console.error);