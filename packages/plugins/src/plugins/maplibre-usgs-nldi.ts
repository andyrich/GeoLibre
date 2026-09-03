import type { Feature, FeatureCollection, Geometry, Point } from "geojson";
import {
  Popup,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const USGS_NLDI_PLUGIN_ID = "maplibre-usgs-nldi";
export const NLDI_API = "https://api.water.usgs.gov/nldi";
const FLOWTRACE_SOURCE = "usgs-nldi-flowtrace-source";
const FLOWTRACE_LAYER = "usgs-nldi-flowtrace";
const RAINDROP_SOURCE = "usgs-nldi-raindrop-source";
const RAINDROP_LAYER = "usgs-nldi-raindrop";
const BASIN_SOURCE = "usgs-nldi-basin-source";
const BASIN_FILL = "usgs-nldi-basin-fill";
const BASIN_LINE = "usgs-nldi-basin-line";
const POINT_SOURCE = "usgs-nldi-point-source";
const POINT_LAYER = "usgs-nldi-point";
const PANEL = "usgs-nldi-panel";
const REQUEST_TIMEOUT_MS = 30_000;

export type NldiDirection = "none" | "up" | "down";

export interface NldiTraceResult {
  flowline: FeatureCollection;
  raindropPath: FeatureCollection;
  comid?: string;
}

export function buildHydrolocationUrl(lon: number, lat: number): string {
  const url = new URL(`${NLDI_API}/linked-data/hydrolocation`);
  url.searchParams.set("f", "json");
  url.searchParams.set("coords", `POINT(${lon} ${lat})`);
  return url.toString();
}

export function buildBasinUrl(
  featureSource: string,
  featureId: string,
  options: { simplified?: boolean } = {},
): string {
  const url = new URL(
    `${NLDI_API}/linked-data/${encodeURIComponent(featureSource)}/${encodeURIComponent(featureId)}/basin`,
  );
  url.searchParams.set("f", "json");
  url.searchParams.set("simplified", String(options.simplified ?? true));
  return url.toString();
}

export function buildNavigationUrl(comid: string): string {
  return `${NLDI_API}/linked-data/comid/${encodeURIComponent(comid)}/navigation?f=json`;
}

export function buildNavigationSourceUrl(
  url: string,
  options: {
    distance?: number;
    trimStart?: boolean;
    stopComid?: string;
    trimTolerance?: number;
  } = {},
): string {
  const target = new URL(url);
  target.searchParams.set("distance", String(options.distance ?? 500));
  if (options.trimStart) target.searchParams.set("trimStart", "true");
  if (options.stopComid) target.searchParams.set("stopComid", options.stopComid);
  if (options.trimTolerance !== undefined)
    target.searchParams.set("trimTolerance", String(options.trimTolerance));
  return target.toString();
}

export function buildFlowtraceBody(
  lon: number,
  lat: number,
  direction: NldiDirection = "none",
): string {
  return JSON.stringify({ inputs: { lat, lon, direction } });
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function asCollection(value: unknown): FeatureCollection {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "FeatureCollection"
  ) {
    return value as FeatureCollection;
  }
  if (value && typeof value === "object" && (value as { type?: string }).type === "Feature") {
    return { type: "FeatureCollection", features: [value as Feature] };
  }
  if (value && typeof value === "object" && typeof (value as { type?: string }).type === "string") {
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: value as Geometry, properties: {} }],
    };
  }
  return emptyCollection();
}

function findValue(value: unknown, names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const name of names) {
    const found = object[name] ?? object[name.toLowerCase()];
    if (found !== undefined && found !== null && found !== "") return String(found);
  }
  return undefined;
}

export function parseFlowtraceResponse(data: unknown): NldiTraceResult {
  const object = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const flowlineValue = object.flowline ?? object.flowLine ?? (object.features ? data : object);
  const flowline = asCollection(flowlineValue);
  const raindropPath = asCollection(object.raindropPath ?? object.raindrop_path ?? object.raindrop);
  const firstProperties = flowline.features[0]?.properties;
  const comid =
    findValue(firstProperties, ["comid", "COMID"]) ?? findValue(object, ["comid", "COMID"]);
  return { flowline, raindropPath, comid };
}

function parseNavigationSources(data: unknown): Record<string, string> {
  const sources: Record<string, string> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    const source = findValue(object, ["source"]);
    const features = findValue(object, ["features"]);
    if (source && features?.startsWith("http")) sources[source] = features;
    Object.values(object).forEach((child) => {
      if (typeof child === "object") visit(child);
    });
  };
  visit(data);
  return sources;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const inheritedSignal = init?.signal;
  const abort = () => controller.abort();
  inheritedSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      let detail = "";
      try {
        detail = String(((await response.json()) as { description?: unknown }).description ?? "");
      } catch {
        /* non-JSON error */
      }
      throw new Error(`USGS NLDI returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
    inheritedSignal?.removeEventListener("abort", abort);
  }
}

function pointFromHydrolocation(data: unknown): { point?: Point; comid?: string } {
  const features =
    (data && typeof data === "object" ? (data as { features?: Feature[] }).features : undefined) ??
    [];
  const networkFeature = features.find(
    (feature) => feature.properties && findValue(feature.properties, ["comid", "COMID"]),
  );
  const pointFeature = features.find(
    (feature) =>
      feature.geometry?.type === "Point" &&
      findValue(feature.properties, ["type"]) === "hydrolocation",
  );
  return {
    point: pointFeature?.geometry?.type === "Point" ? pointFeature.geometry : undefined,
    comid: findValue(networkFeature?.properties, ["comid", "COMID"]),
  };
}

async function fallbackTrace(
  lon: number,
  lat: number,
  direction: NldiDirection,
  signal?: AbortSignal,
): Promise<{ trace: NldiTraceResult; usedFallback: boolean }> {
  if (direction !== "none")
    throw new Error(
      "Directional flowtrace is unavailable while the USGS process is offline. Choose Complete flowline or try again later.",
    );
  const hydrolocation = await fetchJson(buildHydrolocationUrl(lon, lat), { signal });
  const resolved = pointFromHydrolocation(hydrolocation);
  if (!resolved.comid) throw new Error("NLDI could not find a flowline near this point.");
  const flowline = asCollection(
    await fetchJson(`${NLDI_API}/linked-data/comid/${encodeURIComponent(resolved.comid)}?f=json`, {
      signal,
    }),
  );
  const raindropPath = resolved.point
    ? ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[lon, lat], resolved.point.coordinates] },
            properties: {},
          },
        ],
      } as FeatureCollection)
    : emptyCollection();
  return { trace: { flowline, raindropPath, comid: resolved.comid }, usedFallback: true };
}

function setSource(map: MapLibreMap, id: string, data: FeatureCollection): void {
  const source = map.getSource(id) as { setData?: (next: FeatureCollection) => void } | undefined;
  if (source?.setData) source.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

function addLayers(map: MapLibreMap): void {
  if (!map.getLayer(FLOWTRACE_LAYER))
    map.addLayer({
      id: FLOWTRACE_LAYER,
      type: "line",
      source: FLOWTRACE_SOURCE,
      paint: { "line-color": "#1677c8", "line-width": 4 },
    });
  if (!map.getLayer(RAINDROP_LAYER))
    map.addLayer({
      id: RAINDROP_LAYER,
      type: "line",
      source: RAINDROP_SOURCE,
      paint: { "line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 2] },
    });
  if (!map.getLayer(BASIN_FILL))
    map.addLayer({
      id: BASIN_FILL,
      type: "fill",
      source: BASIN_SOURCE,
      paint: { "fill-color": "#38bdf8", "fill-opacity": 0.18 },
    });
  if (!map.getLayer(BASIN_LINE))
    map.addLayer({
      id: BASIN_LINE,
      type: "line",
      source: BASIN_SOURCE,
      paint: { "line-color": "#0284c7", "line-width": 2 },
    });
  if (!map.getLayer(POINT_LAYER))
    map.addLayer({
      id: POINT_LAYER,
      type: "circle",
      source: POINT_SOURCE,
      paint: {
        "circle-radius": 6,
        "circle-color": "#dc2626",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    });
}

function clearResult(map: MapLibreMap): void {
  for (const layer of [POINT_LAYER, BASIN_LINE, BASIN_FILL, RAINDROP_LAYER, FLOWTRACE_LAYER])
    if (map.getLayer(layer)) map.removeLayer(layer);
  for (const source of [POINT_SOURCE, BASIN_SOURCE, RAINDROP_SOURCE, FLOWTRACE_SOURCE])
    if (map.getSource(source)) map.removeSource(source);
}

function render(map: MapLibreMap, point: Point, trace: NldiTraceResult): void {
  setSource(map, FLOWTRACE_SOURCE, trace.flowline);
  setSource(map, RAINDROP_SOURCE, trace.raindropPath);
  setSource(map, POINT_SOURCE, {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: point, properties: {} }],
  });
  addLayers(map);
}

function renderBasin(map: MapLibreMap, basin: FeatureCollection): void {
  setSource(map, BASIN_SOURCE, basin);
  addLayers(map);
}

function addLayerTag(data: FeatureCollection, layer: string): FeatureCollection {
  return {
    ...data,
    features: data.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, _nldiLayer: layer },
    })),
  };
}

function exportCollection(parts: Array<[string, FeatureCollection]>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: parts.flatMap(([layer, collection]) => addLayerTag(collection, layer).features),
  };
}

interface PlottedNavigationLayer {
  sourceId: string;
  layerIds: string[];
  data: FeatureCollection;
  removeHover: () => void;
}

function addNavigationLayer(
  map: MapLibreMap,
  data: FeatureCollection,
  label: string,
  index: number,
): PlottedNavigationLayer {
  const sourceId = `usgs-nldi-navigation-source-${index}`;
  const lineId = `usgs-nldi-navigation-line-${index}`;
  const pointId = `usgs-nldi-navigation-point-${index}`;
  map.addSource(sourceId, { type: "geojson", data });
  const hasLines = data.features.some(
    (feature) =>
      feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString",
  );
  const hasPoints = data.features.some(
    (feature) => feature.geometry?.type === "Point" || feature.geometry?.type === "MultiPoint",
  );
  const layerIds: string[] = [];
  if (hasLines) {
    map.addLayer({
      id: lineId,
      type: "line",
      source: sourceId,
      filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
      paint: { "line-color": "#7c3aed", "line-width": 2.5, "line-opacity": 0.8 },
    });
    layerIds.push(lineId);
  }
  if (hasPoints) {
    map.addLayer({
      id: pointId,
      type: "circle",
      source: sourceId,
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      paint: {
        "circle-radius": 4,
        "circle-color": "#7c3aed",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.25,
      },
    });
    layerIds.push(pointId);
  }
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  const enter = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    map.getCanvas().style.cursor = "pointer";
    popup
      .setLngLat(event.lngLat)
      .setText(`${label}\n${popupText(feature?.properties as Record<string, unknown> | undefined)}`)
      .addTo(map);
  };
  const move = (event: MapLayerMouseEvent) => {
    if (popup.isOpen()) popup.setLngLat(event.lngLat);
  };
  const leave = () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  };
  for (const layerId of layerIds) {
    map.on("mouseenter", layerId, enter);
    map.on("mousemove", layerId, move);
    map.on("mouseleave", layerId, leave);
  }
  return {
    sourceId,
    layerIds,
    data,
    removeHover: () => {
      for (const layerId of layerIds) {
        map.off("mouseenter", layerId, enter);
        map.off("mousemove", layerId, move);
        map.off("mouseleave", layerId, leave);
      }
      popup.remove();
    },
  };
}

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.style.cssText =
    "padding:6px 8px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;cursor:pointer;";
  return element;
}

function sourceLabel(name: string): string {
  const labels: Record<string, string> = {
    ca_gages: "California streamgages (ca_gages)",
    nwissite: "NWIS surface-water sites (streamgages)",
    nwisgw: "NWIS groundwater wells",
    gfv11_pois: "USGS Geospatial Fabric points",
    huc12pp: "HUC12 pour points",
    "nmwdi-st": "New Mexico water sites",
    flowlines: "NHDPlus flowlines",
  };
  return labels[name.toLowerCase()] ?? name;
}

function popupText(properties: Record<string, unknown> | null | undefined): string {
  if (!properties) return "No attributes returned by NLDI.";
  const entries = Object.entries(properties)
    .filter(([key, value]) => !key.startsWith("_") && value !== null && value !== "")
    .slice(0, 8);
  return entries.length
    ? entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n")
    : "No attributes returned by NLDI.";
}

export const maplibreUsgsNldiPlugin: GeoLibrePlugin = {
  id: USGS_NLDI_PLUGIN_ID,
  name: "USGS NLDI",
  version: "1.0.0",
  activate(app: GeoLibreAppAPI) {
    const map = app.getMap?.();
    if (!map) return false;
    let selected: { point: Point; comid?: string } | null = null;
    let traceResult: NldiTraceResult | null = null;
    let basinResult: FeatureCollection | null = null;
    const plottedNavigation: PlottedNavigationLayer[] = [];
    let disposed = false;
    let requestId = 0;
    let activeAbortController: AbortController | null = null;
    const direction = document.createElement("select");
    direction.append(
      new Option("Complete flowline — returns the full NHD reach", "none"),
      new Option("Upstream only — returns the reach above the point", "up"),
      new Option("Downstream only — returns the reach below the point", "down"),
    );
    direction.style.cssText =
      "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;";
    const status = document.createElement("div");
    status.style.cssText = "line-height:1.4;color:hsl(var(--muted-foreground));";
    const basinButton = button("Basin from hydrolocation");
    basinButton.disabled = true;
    const navigation = document.createElement("select");
    navigation.append(
      new Option("Select direction — required before plotting", ""),
      new Option("Upstream main — follow the primary channel", "upstreamMain"),
      new Option("Upstream tributaries — find contributing branches", "upstreamTributaries"),
      new Option("Downstream main — follow the primary channel", "downstreamMain"),
      new Option("Downstream diversions — follow split-flow paths", "downstreamDiversions"),
    );
    navigation.style.cssText =
      "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;";
    const source = document.createElement("select");
    source.append(new Option("Press ‘Load sources & plot’ first", ""));
    source.disabled = true;
    source.style.cssText =
      "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;";
    const distance = document.createElement("input");
    distance.type = "number";
    distance.min = "1";
    distance.max = "9999";
    distance.step = "1";
    distance.value = "500";
    distance.placeholder = "Distance (km)";
    distance.style.cssText =
      "padding:6px;border:1px solid hsl(var(--border));border-radius:5px;background:transparent;color:inherit;";
    const navigationButton = button("1. Load sources & plot navigation");
    navigationButton.disabled = true;
    navigationButton.style.cssText +=
      "font-weight:700;background:hsl(var(--primary));color:hsl(var(--primary-foreground));min-height:36px;";
    const exportButton = button("Export rendered results to GeoJSON");
    exportButton.disabled = true;
    const addLayersButton = button("Add rendered results to GeoLibre Layers");
    addLayersButton.disabled = true;
    const clearButton = button("Clear NLDI result");
    let navigationSources: Record<string, string> = {};
    let loadedNavigation = "";
    const clearPlottedNavigation = () => {
      plottedNavigation.splice(0).forEach((plotted) => {
        plotted.removeHover();
        plotted.layerIds.forEach((id) => {
          if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource(plotted.sourceId)) map.removeSource(plotted.sourceId);
      });
    };
    const resetResultState = () => {
      clearPlottedNavigation();
      clearResult(map);
      selected = null;
      traceResult = null;
      basinResult = null;
      navigationSources = {};
      loadedNavigation = "";
      source.replaceChildren(new Option("Press ‘Load sources & plot’ first", ""));
      basinButton.disabled = true;
      navigationButton.disabled = true;
      source.disabled = true;
      exportButton.disabled = true;
      addLayersButton.disabled = true;
      navigationButton.textContent = "1. Load sources & plot navigation";
    };
    const beginRequest = (): AbortSignal => {
      activeAbortController?.abort();
      activeAbortController = new AbortController();
      return activeAbortController.signal;
    };
    const isCurrent = (generation: number, comid: string): boolean =>
      !disposed && generation === requestId && selected?.comid === comid;
    const containerRender = (container: HTMLElement) => {
      container.replaceChildren();
      container.style.cssText =
        "display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;height:100%;overflow:auto;font-size:12px;color:hsl(var(--foreground));";
      const title = document.createElement("strong");
      title.textContent = "USGS NLDI network tools";
      const hint = document.createElement("div");
      hint.textContent =
        "First choose a flowline direction and click the map. Then choose a navigation direction, press the highlighted button to load available catalogs, select a catalog such as streamgages or wells, and press it again to plot that catalog.";
      hint.style.lineHeight = "1.4";
      container.append(
        title,
        hint,
        direction,
        basinButton,
        navigation,
        source,
        distance,
        navigationButton,
        addLayersButton,
        exportButton,
        clearButton,
        status,
      );
      return () => undefined;
    };
    const setStatus = (message: string) => {
      status.textContent = message;
    };
    const lookupBasin = async () => {
      if (!selected?.comid) {
        setStatus("No COMID was returned for this point.");
        return;
      }
      const generation = requestId;
      const comid = selected.comid;
      const signal = beginRequest();
      setStatus("Requesting upstream basin…");
      try {
        const basin = asCollection(await fetchJson(buildBasinUrl("comid", comid), { signal }));
        if (!isCurrent(generation, comid)) return;
        basinResult = basin;
        renderBasin(map, basin);
        exportButton.disabled = false;
        addLayersButton.disabled = false;
        setStatus(`Upstream basin rendered for COMID ${comid}.`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Basin request failed.");
      }
    };
    const plotNavigation = async () => {
      if (!selected?.comid || !navigation.value) {
        setStatus("Select a navigation method after tracing a point.");
        return;
      }
      const km = Number(distance.value);
      if (!Number.isFinite(km) || km < 1 || km > 9999) {
        setStatus("Distance must be between 1 and 9999 km.");
        return;
      }
      const generation = requestId;
      const comid = selected.comid;
      const signal = beginRequest();
      setStatus("Discovering NLDI navigation sources…");
      try {
        if (loadedNavigation !== navigation.value) {
          const links = await fetchJson(buildNavigationUrl(comid), { signal });
          if (!isCurrent(generation, comid)) return;
          const navigationUrl = (links as Record<string, unknown>)[navigation.value];
          if (typeof navigationUrl !== "string")
            throw new Error("That navigation method is not available for this COMID.");
          navigationSources = parseNavigationSources(
            await fetchJson(buildNavigationSourceUrl(navigationUrl, { distance: km }), { signal }),
          );
          if (!isCurrent(generation, comid)) return;
          source.replaceChildren(
            ...Object.keys(navigationSources)
              .sort((a, b) =>
                a.toLowerCase() === "flowlines"
                  ? -1
                  : b.toLowerCase() === "flowlines"
                    ? 1
                    : a.localeCompare(b),
              )
              .map((name) => new Option(sourceLabel(name), name)),
          );
          source.disabled = false;
          source.value =
            Object.keys(navigationSources).find((name) => name.toLowerCase() === "flowlines") ??
            Object.keys(navigationSources)[0] ??
            "";
          loadedNavigation = navigation.value;
        }
        const sourceUrl = navigationSources[source.value];
        if (!sourceUrl) throw new Error("NLDI returned no plottable navigation source.");
        const result = asCollection(
          await fetchJson(buildNavigationSourceUrl(sourceUrl, { distance: km }), { signal }),
        );
        if (!isCurrent(generation, comid)) return;
        const plotted = addNavigationLayer(
          map,
          result,
          `${sourceLabel(source.value)} · ${navigation.value}`,
          plottedNavigation.length + 1,
        );
        plottedNavigation.push(plotted);
        exportButton.disabled = false;
        addLayersButton.disabled = false;
        navigationButton.textContent = "Plot another navigation layer";
        setStatus(
          `Added ${sourceLabel(source.value)} via ${navigation.value} for COMID ${comid} (${km} km). Existing navigation layers remain on the map.`,
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Navigation request failed.");
      }
    };
    const onClick = async (event: MapMouseEvent) => {
      const currentRequest = ++requestId;
      const signal = beginRequest();
      const point: Point = { type: "Point", coordinates: [event.lngLat.lng, event.lngLat.lat] };
      selected = { point };
      basinButton.disabled = true;
      navigationButton.disabled = true;
      source.disabled = true;
      loadedNavigation = "";
      navigationSources = {};
      source.replaceChildren(new Option("Press ‘Load sources & plot’ first", ""));
      traceResult = null;
      basinResult = null;
      clearResult(map);
      exportButton.disabled = true;
      addLayersButton.disabled = true;
      setStatus("Tracing to the nearest NHD flowline…");
      try {
        let trace: NldiTraceResult;
        let usedFallback = false;
        try {
          trace = parseFlowtraceResponse(
            await fetchJson(`${NLDI_API}/pygeoapi/processes/nldi-flowtrace/execution?f=json`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: buildFlowtraceBody(
                event.lngLat.lng,
                event.lngLat.lat,
                direction.value as NldiDirection,
              ),
              signal,
            }),
          );
        } catch (processError) {
          const fallback = await fallbackTrace(
            event.lngLat.lng,
            event.lngLat.lat,
            direction.value as NldiDirection,
            signal,
          );
          trace = fallback.trace;
          usedFallback = fallback.usedFallback;
          console.warn(
            "USGS NLDI flowtrace process was unavailable; used hydrolocation fallback.",
            processError,
          );
        }
        if (disposed || currentRequest !== requestId) return;
        selected = { point, comid: trace.comid };
        traceResult = trace;
        basinResult = null;
        addLayersButton.disabled = false;
        render(map, point, trace);
        const hydro = await fetchJson(buildHydrolocationUrl(event.lngLat.lng, event.lngLat.lat), {
          signal,
        });
        if (disposed || currentRequest !== requestId) return;
        const hydroObject = (hydro && typeof hydro === "object" ? hydro : {}) as Record<
          string,
          unknown
        >;
        selected.comid =
          trace.comid ??
          findValue(hydroObject, ["comid", "COMID"]) ??
          findValue((hydroObject.features as Feature[] | undefined)?.[0]?.properties, [
            "comid",
            "COMID",
          ]);
        basinButton.disabled = !selected.comid;
        navigationButton.disabled = !selected.comid;
        source.disabled = !selected.comid;
        setStatus(
          `${usedFallback ? "Flowline rendered using NLDI hydrolocation fallback" : "Flowline rendered"}${selected.comid ? `; COMID ${selected.comid} is ready for basin workflows.` : "."}`,
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "NLDI request failed.");
      }
    };
    // MapLibre does not await event-listener promises. Keep an explicit catch
    // at the event boundary so a synchronous UI/rendering failure cannot become
    // a browser-level unhandled promise rejection.
    const clickListener = (event: MapMouseEvent) => {
      void onClick(event).catch((error: unknown) => {
        if (!disposed) setStatus(error instanceof Error ? error.message : "NLDI request failed.");
      });
    };
    let resourcesBound = false;
    const cleanupResources = () => {
      if (resourcesBound) {
        resourcesBound = false;
        map.off("click", clickListener);
        map.getCanvas().style.cursor = "";
      }
      activeAbortController?.abort();
      activeAbortController = null;
      ++requestId;
      resetResultState();
    };
    const bindResources = () => {
      if (disposed || resourcesBound) return;
      resourcesBound = true;
      map.on("click", clickListener);
      map.getCanvas().style.cursor = "crosshair";
    };
    const unregister = app.registerRightPanel?.({
      id: PANEL,
      title: "USGS NLDI",
      dock: "replace-style",
      defaultWidth: 330,
      render: containerRender,
      onClose: cleanupResources,
      onOpen: bindResources,
    });
    basinButton.addEventListener("click", () => void lookupBasin());
    navigationButton.addEventListener("click", () => void plotNavigation());
    exportButton.addEventListener("click", () => {
      if (!selected || !traceResult) return;
      const parts: Array<[string, FeatureCollection]> = [
        ["flowline", traceResult.flowline],
        ["raindropPath", traceResult.raindropPath],
        [
          "selectedPoint",
          {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: selected.point,
                properties: { comid: selected.comid ?? "" },
              },
            ],
          },
        ],
      ];
      if (basinResult) parts.push(["basin", basinResult]);
      for (const [index, plotted] of plottedNavigation.entries())
        parts.push([`navigation-${index + 1}`, plotted.data]);
      app.exportTextFile?.(
        `nldi-${selected.comid ?? "result"}.geojson`,
        JSON.stringify(exportCollection(parts), null, 2),
        { description: "GeoJSON", extensions: ["geojson"] },
      );
    });
    addLayersButton.addEventListener("click", () => {
      if (!selected || !traceResult || !app.addGeoJsonLayer || !app.addLayerGroup) return;
      const layers: Array<[string, FeatureCollection]> = [
        ["NLDI flowline", traceResult.flowline],
        ["NLDI raindrop path", traceResult.raindropPath],
        [
          "NLDI selected point",
          {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: selected.point,
                properties: { comid: selected.comid ?? "" },
              },
            ],
          },
        ],
      ];
      if (basinResult) layers.push(["NLDI upstream basin", basinResult]);
      plottedNavigation.forEach((plotted, index) =>
        layers.push([`NLDI navigation ${index + 1}`, plotted.data]),
      );
      const layerIds = layers
        .filter(([, data]) => data.features.length > 0)
        .map(([name, data]) => app.addGeoJsonLayer(name, data));
      if (!layerIds.length) {
        setStatus("There are no rendered NLDI features to add.");
        return;
      }
      app.addLayerGroup("USGS NLDI results", layerIds);
      addLayersButton.disabled = true;
      setStatus(`Added ${layerIds.length} NLDI layers to one “USGS NLDI results” group.`);
    });
    navigation.addEventListener("change", () => {
      loadedNavigation = "";
      navigationSources = {};
      source.replaceChildren(new Option("Press ‘Load sources & plot’ first", ""));
      source.disabled = true;
    });
    clearButton.addEventListener("click", () => {
      activeAbortController?.abort();
      activeAbortController = null;
      ++requestId;
      resetResultState();
      setStatus("NLDI result cleared.");
    });
    bindResources();
    app.openRightPanel?.(PANEL);
    (map as MapLibreMap & { __usgsNldiCleanup?: () => void }).__usgsNldiCleanup = () => {
      disposed = true;
      ++requestId;
      cleanupResources();
      unregister?.();
      app.closeRightPanel?.(PANEL);
    };
  },
  deactivate(app) {
    app.getMap?.() &&
      (app.getMap() as MapLibreMap & { __usgsNldiCleanup?: () => void }).__usgsNldiCleanup?.();
  },
};

export default maplibreUsgsNldiPlugin;
