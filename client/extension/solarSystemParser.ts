/**
 * Compatibility shim: the solar system parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview import sites keep working unchanged.
 */
export { ValueOrRange, AsteroidBelt, RingSegment, RingGroup, CelestialBody, SolarSystem, parseSolarSystemFile, resolveValue, resolveCount, toRelativeOrbitAngle } from 'cwtools-shared';
