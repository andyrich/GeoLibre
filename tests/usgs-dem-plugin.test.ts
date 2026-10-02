import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const installDom = () => {
  const { document, window } = parseHTML("<html><body></body></html>");
  class TestCustomEvent<T = unknown> extends Event {
    detail: T;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type);
      this.detail = init?.detail as T;
    }
  }
  Object.assign(globalThis, {
    document,
    window,
    CustomEvent: TestCustomEvent,
    CSS: { escape: (value: string) => value },
  });
  return { document, window };
};

installDom();

import {
  maplibreUsgsDemPlugin,
  setUsgsDemLabels,
  USGS_DEM_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-usgs-dem";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import { pluginTier } from "../apps/geolibre-desktop/src/lib/ui-profile";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("USGS DEM Downloader built-in plugin", () => {
  it("is registered as an advanced Web Services plugin", () => {
    assert.equal(USGS_DEM_PLUGIN_ID, "maplibre-gl-usgs-dem");
    assert.equal(maplibreUsgsDemPlugin.id, USGS_DEM_PLUGIN_ID);
    assert.equal(maplibreUsgsDemPlugin.name, "USGS DEM Downloader");
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(USGS_DEM_PLUGIN_ID));
    assert.equal(pluginTier(USGS_DEM_PLUGIN_ID), "advanced");
  });

  it("activates, registers its right panel, and opens it in the host application", () => {
    let panelRegistered = false;
    let panelOptions: any = null;
    let unregisterCalled = false;
    let openRightPanelCalledWith: string | null = null;
    let closeRightPanelCalledWith: string | null = null;

    const mockApp = {
      getMap: () => ({
        getSource: () => null,
        getLayer: () => null,
        addSource: () => {},
        addLayer: () => {},
        removeLayer: () => {},
        removeSource: () => {},
        on: () => {},
        off: () => {},
      }),
      registerRightPanel: (opts: any) => {
        panelRegistered = true;
        panelOptions = opts;
        return () => {
          unregisterCalled = true;
        };
      },
      openRightPanel: (id: string) => {
        openRightPanelCalledWith = id;
      },
      closeRightPanel: (id: string) => {
        closeRightPanelCalledWith = id;
      },
      unregisterExternalNativeLayer: () => {},
    } as unknown as GeoLibreAppAPI;

    maplibreUsgsDemPlugin.activate(mockApp);
    assert.equal(panelRegistered, true);
    assert.equal(panelOptions?.id, USGS_DEM_PLUGIN_ID);
    assert.equal(panelOptions?.dock, "replace-style");
    assert.equal(openRightPanelCalledWith, USGS_DEM_PLUGIN_ID);

    // Test render container mount
    const container = document.createElement("div");
    const cleanup = panelOptions?.render(container);
    assert.ok(container.querySelector(".geolibre-usgs-dem-panel") || container.classList.contains("geolibre-usgs-dem-panel"));
    if (typeof cleanup === "function") cleanup();

    maplibreUsgsDemPlugin.deactivate?.(mockApp);
    assert.equal(unregisterCalled, true);
    assert.equal(closeRightPanelCalledWith, USGS_DEM_PLUGIN_ID);
  });

  it("supports updating localized labels dynamically", () => {
    setUsgsDemLabels({
      title: "Custom DEM Title",
      search: "Find Elev",
    });
    // Setting labels should run without error
  });
});
