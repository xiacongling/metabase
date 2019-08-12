/// code to "apply" chart tooltips. (How does one apply a tooltip?)

import _ from "underscore";
import d3 from "d3";
import moment from "moment";

import { formatValue } from "metabase/lib/formatting";

import { isNormalized, isStacked } from "./renderer_utils";
import { determineSeriesIndexFromElement } from "./tooltip";
import { getFriendlyName } from "./utils";

export function getClickHoverObject(
  d,
  { series, isNormalized, isStacked, isScalarSeries, chart },
) {
  let { cols } = series[0].data;
  const seriesIndex = determineSeriesIndexFromElement(this, isStacked);
  const seriesSettings = chart.settings.series(series[seriesIndex]);
  const seriesTitle = seriesSettings && seriesSettings.title;

  const card = series[seriesIndex].card;

  const isMultiseries = series.length > 1;
  const isBreakoutMultiseries = isMultiseries && card._breakoutColumn;
  const isBar = this.classList.contains("bar");
  const isSingleSeriesBar = isBar && !isMultiseries;

  // always format the second column as the series name?
  function getColumnDisplayName(col) {
    // don't replace with series title for breakout multiseries since the series title is shown in the breakout value
    if (col === cols[1] && !isBreakoutMultiseries && seriesTitle) {
      return seriesTitle;
    } else {
      return getFriendlyName(col);
    }
  }

  let data = [];
  let dimensions = [];
  let value;
  if (Array.isArray(d.key)) {
    value = d.key[2];
    // scatter
    if (d.key._origin) {
      data = d.key._origin.row.map((value, index) => {
        const col = d.key._origin.cols[index];
        return {
          key: getColumnDisplayName(col),
          value: value,
          col,
        };
      });
    } else {
      data = d.key.map((value, index) => ({
        key: getColumnDisplayName(cols[index]),
        value: value,
        col: cols[index],
      }));
    }
    dimensions = [
      { value: d.key[0], column: cols[0] },
      { value: d.key[1], column: cols[1] },
    ];
    if (isBreakoutMultiseries) {
      const { _breakoutValue: value, _breakoutColumn: column } = card;
      dimensions.push({ value, column });
    }
  } else if (d.data) {
    ({ value } = d.data);
    // line, area, bar
    if (!isSingleSeriesBar) {
      cols = series[seriesIndex].data.cols;
    }

    const seriesData = series[seriesIndex].data || {};
    const rawCols = seriesData._rawCols || cols;
    const row = seriesData.rows.find(
      ([x]) =>
        String(x) === String(d.x) ||
        (moment.isMoment(d.x) &&
          formatValue(d.x, { column: rawCols[0] }) === String(x)),
    );
    // try to get row from _origin but fall back to the row we already have
    const { _origin: { row: rawRow = row } = {} } = row;

    // Loop over *all* of the columns and create the new array
    if (rawRow) {
      data = rawCols.map((col, i) => {
        if (isNormalized && cols[1].field_ref === col.field_ref) {
          return {
            key: getColumnDisplayName(cols[1]),
            value: formatValue(d.data.value, {
              number_style: "percent",
              column: cols[1],
              decimals: cols[1].decimals,
            }),
            col: col,
          };
        }
        return {
          key: getColumnDisplayName(col),
          value: rawRow[i],
          col: col,
        };
      });
    }
    dimensions = rawCols.map((column, i) => ({ column, value: rawRow[i] }));
  } else if (isBreakoutMultiseries) {
    // an area doesn't have any data, but might have a breakout series to show
    const { _breakoutValue: value, _breakoutColumn: column } = card;
    data = [
      {
        key: getColumnDisplayName(card._breakoutColumn),
        col: column,
        value,
      },
    ];
    dimensions = [{ column, value }];
  }

  // overwrite value/col for breakout column
  data = data.map(d =>
    d.col === card._breakoutColumn
      ? {
          ...d,
          // Use series title if it's set
          value: seriesTitle ? seriesTitle : card._breakoutValue,
          // Don't include the column if series title is set (it's already formatted)
          col: seriesTitle ? null : card._breakoutColumn,
        }
      : d,
  );

  dimensions = dimensions.filter(
    ({ column }) =>
      // don't include aggregations since we can't filter on them
      column.source !== "aggregation" &&
      // these columns come from scalar series names
      column.source !== "query-transform",
  );

  // NOTE: certain values such as booleans were coerced to strings at some point. fix them.
  for (const dimension of dimensions) {
    dimension.value = parseBooleanStringValue(dimension);
  }
  const column = series[seriesIndex].data.cols[1];
  value = parseBooleanStringValue({ column, value });

  // We align tooltips differently depending on the type of chart and whether
  // the user is hovering/clicked.
  //
  // On hover, we want to put the tooltip statically next to the hovered element
  // *unless* the element is an area. Those are weirdly shaped, so we put the
  // tooltip next to the mouse.
  //
  // On click, it's somewhat reversed. Typically we want the tooltip to appear
  // right next to where the user just clicked. The exception is line charts.
  // There we want to snap to the closest hovered dot since the voronoi snapping
  // we do means the mouse might be slightly off.
  const isLine = this.classList.contains("dot");
  const isArea = this.classList.contains("area");
  const shouldUseMouseCoordinates =
    d3.event.type === "mousemove" ? isArea : !isLine;

  return {
    // for single series bar charts, fade the series and highlght the hovered element with CSS
    index: isSingleSeriesBar ? -1 : seriesIndex,
    element: !shouldUseMouseCoordinates ? this : null,
    event: shouldUseMouseCoordinates ? d3.event : null,
    data: data.length > 0 ? data : null,
    dimensions,
    value,
    column,
  };
}

function parseBooleanStringValue({ column, value }) {
  if (column && column.base_type === "type/Boolean") {
    if (value === "true") {
      return true;
    } else if (value === "false") {
      return false;
    }
  }
  return value;
}

// series = an array of serieses (?) in the chart. There's only one thing in here unless we're dealing with a multiseries chart
function applyChartTooltips(
  chart,
  series,
  isStacked,
  isNormalized,
  isScalarSeries,
  onHoverChange,
  onVisualizationClick,
) {
  chart.on("renderlet.tooltips", function(chart) {
    // remove built-in tooltips
    chart.selectAll("title").remove();

    const getObjectArgs = {
      chart,
      series,
      isNormalized,
      isScalarSeries,
      isStacked,
    };

    if (onHoverChange) {
      chart
        .selectAll(".bar, .dot, .area, .line, .bubble")
        .on("mousemove", function(d) {
          const hovered = getClickHoverObject.call(this, d, getObjectArgs);
          onHoverChange(hovered);
        })
        .on("mouseleave", function() {
          if (!onHoverChange) {
            return;
          }
          onHoverChange(null);
        });
    }

    if (onVisualizationClick) {
      const onClick = function(d) {
        const clicked = getClickHoverObject.call(this, d, getObjectArgs);

        if (clicked) {
          onVisualizationClick(clicked);
        }
      };

      // for some reason interaction with brush requires we use click for .dot and .bubble but mousedown for bar
      chart
        .selectAll(".dot, .bubble")
        .style({ cursor: "pointer" })
        .on("click", onClick);
      chart
        .selectAll(".bar")
        .style({ cursor: "pointer" })
        .on("mousedown", onClick);
    }
  });
}

export function setupTooltips(
  { settings, series, isScalarSeries, onHoverChange, onVisualizationClick },
  datas,
  parent,
  { isBrushing },
) {
  applyChartTooltips(
    parent,
    series,
    isStacked(settings, datas),
    isNormalized(settings, datas),
    isScalarSeries,
    hovered => {
      // disable tooltips while brushing
      if (onHoverChange && !isBrushing()) {
        // disable tooltips on lines
        if (
          hovered &&
          hovered.element &&
          hovered.element.classList.contains("line")
        ) {
          delete hovered.element;
        }
        onHoverChange(hovered);
      }
    },
    onVisualizationClick,
  );
}
