import { resultsPayload } from "../server.js";

export default async function handler(request, response) {
  const payload = await resultsPayload();
  response.setHeader("cache-control", "no-cache, no-store, must-revalidate");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.status(200).json(payload);
}
