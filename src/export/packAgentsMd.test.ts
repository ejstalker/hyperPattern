import { describe, expect, it } from 'vitest';
import {
  buildBlenderAgentsMd,
  buildHoudiniAgentsMd,
  type PackAgentsFacts,
} from './packAgentsMd';

/** The shape a real drape produces: gathered seams, pins, a body. */
function facts(overrides: Partial<PackAgentsFacts> = {}): PackAgentsFacts {
  return {
    scene: { project: 'Test project', drape: 'Drape 6', pattern: 'Pattern', mesh: 'Mesh 1' },
    cloth: { vertices: 8550, triangles: 14247 },
    bodyTriangles: 41003,
    seams: { total: 1019, gathered: 764 },
    pins: 120,
    pieces: 12,
    collider: { distanceMetres: 0.0074 },
    fabric: { vertexMassKg: 0.0016, sewingForceMax: 1000, friction: 0.45, quality: 8 },
    substeps: 8,
    ...overrides,
  };
}

describe('buildBlenderAgentsMd', () => {
  it('states the counts an agent has to verify against, and leaves no placeholders', () => {
    const md = buildBlenderAgentsMd(facts());
    expect(md).toContain('# Building this garment in Blender');
    expect(md).toContain('`Drape 6` from project "Test project"');
    expect(md).toContain('8,550 vertices, 14,247 triangles');
    expect(md).toContain('41,003 triangles');
    expect(md).toContain('1,019 (764 of them gathered)');
    expect(md).toContain('7.4 mm');
    expect(md).toContain('1.6 g per vertex');
    expect(md).not.toMatch(/\{\{|\}\}/);
    expect(md).not.toMatch(/undefined|NaN/);
  });

  it('names the objects and groups the builder actually creates', () => {
    const md = buildBlenderAgentsMd(facts());
    expect(md).toContain("bpy.data.objects['hyperpattern_cloth']");
    expect(md).toContain("'hyperpattern_gather'");
    expect(md).toContain("'hyperpattern_pins'");
    // The verify fence has to be runnable Python: no stray indentation.
    const code = /```python\n([\s\S]*?)```/.exec(md)?.[1] ?? '';
    expect(code).toContain("assert 'hyperpattern_gather' in cloth.vertex_groups");
    expect(code).toContain("assert any(m.type == 'COLLISION' for m in body.modifiers)");
    // Every statement in the block is top level, so nothing may be indented.
    const lines = code.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.every((line) => !line.startsWith(' '))).toBe(true);
  });

  it('drops the checks for groups a pack does not have', () => {
    const md = buildBlenderAgentsMd(
      facts({
        bodyTriangles: 0,
        pins: 0,
        seams: { total: 40, gathered: 0 },
      })
    );
    expect(md).not.toContain("'hyperpattern_gather' in cloth.vertex_groups");
    expect(md).not.toContain("'hyperpattern_pins' in cloth.vertex_groups");
    expect(md).not.toContain("bpy.data.objects['hyperpattern_body']");
    expect(md).toContain('none — this drape was exported without an avatar');
    expect(md).toContain('none gathered');
    // Still a usable document, not a truncated one.
    expect(md).toContain('## Do not');
    expect(md).toContain('Merge by distance');
  });

  it('warns about the things that destroy a sewn garment', () => {
    const md = buildBlenderAgentsMd(facts());
    expect(md).toContain('Merge by distance');
    expect(md).toContain('Apply');
    expect(md).toContain('Import twice');
    expect(md).toContain('execute_blender_code');
  });
});

describe('buildHoudiniAgentsMd', () => {
  it('describes the Vellum network and the checks an agent can run over MCP', () => {
    const md = buildHoudiniAgentsMd(facts());
    expect(md).toContain('# Building this garment in Houdini');
    expect(md).toContain('/obj/hp_garment');
    expect(md).toContain('vellum_solver');
    expect(md).toContain('prim count == 1,019');
    expect(md).toContain('point count == 8,550');
    expect(md).toContain('find_error_nodes');
    expect(md).not.toMatch(/\{\{|\}\}/);
  });

  it('calls out the Apprentice limits rather than letting an agent use hython', () => {
    const md = buildHoudiniAgentsMd(facts());
    expect(md).toContain('Python Shell');
    expect(md).toContain('hython');
    expect(md).toContain('.hipnc');
  });
});
