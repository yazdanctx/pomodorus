// Category CRUD — local-first, same as the timer: the write lands in
// storage immediately, and (if signed in) is queued for the server too.

import * as storage from "./storage.js";
import * as sync from "./sync.js";

export async function createCategory({ name, isPublic }) {
  const categories = await storage.getCategories();
  const id = crypto.randomUUID();
  const now = Date.now();
  categories.push({ id, name, public: isPublic, createdAt: now, updatedAt: now, synced: false });
  await storage.setCategories(categories);
  await queueAndSync({ clientId: id, op: "upsert", name, isPublic, at: now });
  return id;
}

export async function renameCategory(id, { name, isPublic }) {
  const categories = await storage.getCategories();
  const cat = categories.find((c) => c.id === id);
  if (!cat) return;
  const now = Date.now();
  cat.name = name;
  cat.public = isPublic;
  cat.updatedAt = now;
  cat.synced = false;
  await storage.setCategories(categories);
  await queueAndSync({ clientId: id, op: "upsert", name, isPublic, at: now });
}

export async function deleteCategory(id) {
  const categories = await storage.getCategories();
  const remaining = categories.filter((c) => c.id !== id);
  await storage.setCategories(remaining);
  const selected = await storage.getSelectedCategoryId();
  if (selected === id) await storage.setSelectedCategoryId(null);
  await queueAndSync({ clientId: id, op: "delete", at: Date.now() });
}

async function queueAndSync(op) {
  if (!(await sync.isSignedIn())) return;
  await storage.queueCategoryOp(op);
  try {
    await sync.syncNow();
  } catch {
    // stays queued, retried by the background alarm
  }
}
