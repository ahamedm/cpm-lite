import type { AuthUser } from '../auth.js';
import type { AnalyticsHandle, ModelSource } from '../analytics.js';

export async function previewModelSources(analytics: AnalyticsHandle, user: AuthUser): Promise<ModelSource[]> {
  void user;
  return analytics.listSources();
}
