import { describe, expect, it, beforeEach } from 'vitest';
import { projectStore } from './ProjectStore';
import { createSmallFixture } from './fixtures';
import { serializeProject } from './projectCodec';
import { MAX_SPEED_MAX } from '../project/createDefault';

const LEGACY_LIBRARY_KEY = 'patternCanvas.library.v1';

async function deleteIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('patternCanvas');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('localStorage migration', () => {
  beforeEach(async () => {
    localStorage.clear();
    projectStore._resetForTests();
    await deleteIdb();
  });

  it('migrates legacy library v1 into IndexedDB', async () => {
    const project = createSmallFixture();
    project.id = 'legacy_project';
    const legacy = {
      version: 1,
      activeId: project.id,
      projects: [
        {
          id: project.id,
          name: project.name,
          updatedAt: Date.now(),
          data: project,
        },
      ],
    };
    localStorage.setItem(LEGACY_LIBRARY_KEY, JSON.stringify(legacy));

    await projectStore.initialize();

    const list = await projectStore.list();
    expect(list.some((p) => p.id === 'legacy_project')).toBe(true);
    const loaded = await projectStore.load('legacy_project');
    expect(loaded?.name).toBe(project.name);
    expect(localStorage.getItem(LEGACY_LIBRARY_KEY)).toBeNull();
  });
});

describe('legacy JSON compatibility', () => {
  it('parses v2 JSON exports', () => {
    const project = createSmallFixture();
    const json = serializeProject(project);
    const imported = projectStore.importJson(json);
    expect(imported.patterns.length).toBe(project.patterns.length);
  });

  it('brings a stored Max speed inside the range the control offers', () => {
    const project = createSmallFixture();
    // Saved back when the clamp ran to 40 with a default of 30.
    project.sims = project.sims.map((sim) => ({
      ...sim,
      params: { ...sim.params, maxSpeed: 30 },
    }));
    const imported = projectStore.importJson(serializeProject(project));
    for (const sim of imported.sims) expect(sim.params.maxSpeed).toBe(MAX_SPEED_MAX);
    // A value already inside the range is left exactly as it was.
    project.sims = project.sims.map((sim) => ({
      ...sim,
      params: { ...sim.params, maxSpeed: 2.5 },
    }));
    const kept = projectStore.importJson(serializeProject(project));
    for (const sim of kept.sims) expect(sim.params.maxSpeed).toBe(2.5);
  });
});
