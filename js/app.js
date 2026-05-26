import { createMap } from "./map_renderer.js";
import { getCurrentItinerary, getCurrentResolution, setupItineraryInput } from "./itinerary.js";
import { setupRailwayData } from "./railway_data.js";

const map = createMap("map");

setupItineraryInput();
setupRailwayData(map, {
  getItinerary: getCurrentItinerary,
  getResolution: getCurrentResolution
});
