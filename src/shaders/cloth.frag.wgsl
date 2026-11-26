// Fragment shader for cloth rendering

struct LightingUniforms {
    ambientColor: vec3<f32>,
    lightDirection: vec3<f32>,
    lightColor: vec3<f32>,
    lightDirection2: vec3<f32>,
    lightColor2: vec3<f32>,
    diffuseColor: vec3<f32>,
    useVertexColor: f32,
}

@group(0) @binding(1) var<uniform> lighting: LightingUniforms;

// Cloth albedo image. The UVs come from the Remesh node's per-piece mapping;
// the white fallback texture keeps the bind group valid with no image loaded,
// and `options.x` says whether to sample it at all.
@group(2) @binding(0) var albedoSampler: sampler;
@group(2) @binding(1) var albedoTexture: texture_2d<f32>;
@group(2) @binding(2) var<uniform> albedoOptions: vec4<f32>;

fn albedoFor(base: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    if (albedoOptions.x < 0.5) {
        return base;
    }
    return textureSample(albedoTexture, albedoSampler, uv).rgb;
}

struct FragmentInput {
    @location(0) fragNormal: vec3<f32>,
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    let normal = normalize(input.fragNormal);
    let irradiance = lighting.ambientColor +
                     lighting.lightColor * max(0.0, dot(lighting.lightDirection, normal)) +
                     lighting.lightColor2 * max(0.0, dot(lighting.lightDirection2, normal));
    let reflectance = irradiance * lighting.diffuseColor;
    return vec4<f32>(sqrt(reflectance), 1.0);
}

struct FragmentInputColor {
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragColor: vec3<f32>,
    @location(2) fragUv: vec2<f32>,
}

@fragment
fn mainColored(input: FragmentInputColor) -> @location(0) vec4<f32> {
    let normal = normalize(input.fragNormal);
    let irradiance = lighting.ambientColor +
                     lighting.lightColor * max(0.0, dot(lighting.lightDirection, normal)) +
                     lighting.lightColor2 * max(0.0, dot(lighting.lightDirection2, normal));
    let base = mix(lighting.diffuseColor, input.fragColor, lighting.useVertexColor);
    let albedo = albedoFor(base, input.fragUv);
    let reflectance = irradiance * albedo;
    return vec4<f32>(sqrt(reflectance), 1.0);
}

struct FragmentInputColorAlpha {
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragColor: vec3<f32>,
    @location(2) fragAlpha: f32,
    @location(3) fragUv: vec2<f32>,
}

/**
 * The alpha-aware fragment stage. The cloth is one draw over the whole mesh, so
 * a translucent piece is picked out per vertex: the opaque pass drops the
 * dimmed fragments and the blended pass keeps only them. Which pass is running
 * is the entry point, not a uniform, so both can be recorded in one pass.
 */
fn clothAlphaFragment(input: FragmentInputColorAlpha, blendedPass: bool) -> vec4<f32> {
    let translucent = input.fragAlpha < 0.999;
    if (translucent != blendedPass) {
        discard;
    }
    let normal = normalize(input.fragNormal);
    let irradiance = lighting.ambientColor +
                     lighting.lightColor * max(0.0, dot(lighting.lightDirection, normal)) +
                     lighting.lightColor2 * max(0.0, dot(lighting.lightDirection2, normal));
    let base = mix(lighting.diffuseColor, input.fragColor, lighting.useVertexColor);
    let albedo = albedoFor(base, input.fragUv);
    let reflectance = irradiance * albedo;
    return vec4<f32>(sqrt(reflectance), select(1.0, input.fragAlpha, translucent));
}

/** Everything except the dimmed pieces. */
@fragment
fn mainColorAlpha(input: FragmentInputColorAlpha) -> @location(0) vec4<f32> {
    return clothAlphaFragment(input, false);
}

/** Only the dimmed pieces, blended over what the opaque pass drew. */
@fragment
fn mainColorAlphaBlend(input: FragmentInputColorAlpha) -> @location(0) vec4<f32> {
    return clothAlphaFragment(input, true);
}
