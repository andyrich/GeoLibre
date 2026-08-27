/* Dash front end for geolibre.DashMap. It uses GeoLibre's existing iframe
 * embed protocol, keeping the Jupyter and Dash map implementations aligned. */
(function () {
  "use strict";
  function DashMap(props) {
    var React = window.React;
    var dash = window.dash_component_api;
    var iframeRef = React.useRef(null);
    React.useEffect(function () {
      var iframe = iframeRef.current;
      if (!iframe) return undefined;
      var origin = new URL(props.appUrl).origin;
      var onMessage = function (event) {
        if (event.source !== iframe.contentWindow || event.origin !== origin) return;
        var data = event.data || {};
        if (data.type === "geolibre:ready" && iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: "geolibre:load-project", project: props.project,
            trustedWidget: false, seq: 1
          }, origin);
        } else if (data.type === "geolibre:event") {
          var payload = data.payload;
          if (data.event === "click" && payload && Array.isArray(payload.lngLat)) {
            payload = Object.assign({}, payload, {
              lngLat: { lng: payload.lngLat[0], lat: payload.lngLat[1] }
            });
          }
          var property = data.event === "click" ? "clickData" :
            data.event === "selection-change" ? "selectionData" : null;
          var setProps = props.setProps || (dash && (dash.set_props || dash.setProps));
          if (property && setProps) setProps({ [property]: payload });
        }
      };
      window.addEventListener("message", onMessage);
      return function () { window.removeEventListener("message", onMessage); };
    }, [props.appUrl, props.project]);
    var query = "?embed=1&theme=" + encodeURIComponent(props.theme || "light");
    if (props.layout === "maponly") query += "&maponly=1";
    else if (props.layout !== "full") query += "&layout=embed";
    return React.createElement("iframe", {
      ref: iframeRef, src: props.appUrl + "index.html" + query,
      title: "GeoLibre map", allow: "fullscreen; geolocation", allowFullScreen: true,
      style: Object.assign({ width: "100%", height: props.height || "800px", border: 0, display: "block" }, props.style || {})
    });
  }
  window.geolibre = window.geolibre || {};
  window.geolibre.DashMap = DashMap;
}());
