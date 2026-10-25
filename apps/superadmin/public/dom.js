/** Code-native presentation helpers. All server content remains text. */
/** @param {Document} documentObject */
export function createConsoleDom(documentObject) {
  /**
   * @param {string} title
   * @param {string} description
   */
  function sectionHeading(title, description) {
    const heading = node("div", "section-heading");
    heading.append(textNode("h2", "", title), textNode("p", "", description));
    return heading;
  }

  /**
   * @param {string} title
   * @param {string} description
   */
  function panel(title, description) {
    const section = node("section", "panel");
    const heading = node("header", "panel-heading");
    heading.append(textNode("h3", "", title), textNode("span", "", description));
    section.append(heading);
    return section;
  }

  /**
   * @param {string[]} headers
   */
  function baseTable(headers) {
    const table = documentObject.createElement("table");
    table.className = "data-table";
    const head = table.createTHead();
    const row = head.insertRow();
    for (const header of headers) {
      const cell = documentObject.createElement("th");
      cell.scope = "col";
      cell.textContent = header;
      row.append(cell);
    }
    table.createTBody();
    return table;
  }

  /**
   * @param {HTMLTableElement} table
   */
  function tableBody(table) {
    const body = table.tBodies.item(0);
    if (body === null) {
      throw new Error("TABLE_BODY_MISSING");
    }
    return body;
  }

  /**
   * @param {HTMLTableRowElement} row
   * @param {string | ReturnType<typeof import("./view-model.js").presentName>} value
   * @param {string} [className]
   */
  function appendCell(row, value, className = "") {
    const cell = row.insertCell();
    cell.setAttribute(
      "data-label",
      row.closest("table")?.querySelectorAll("thead th")[[...row.children].indexOf(cell)]
        ?.textContent ?? "",
    );
    if (className !== "") {
      cell.className = className;
    }
    if (typeof value === "string") {
      cell.textContent = value;
    } else {
      cell.textContent = value.text;
      if (value.title !== null) {
        cell.title = value.title;
      }
    }
  }

  /**
   * @param {HTMLTableRowElement} row
   * @param {string} label
   * @param {string} tone
   */
  function appendPillCell(row, label, tone) {
    const cell = row.insertCell();
    cell.setAttribute(
      "data-label",
      row.closest("table")?.querySelectorAll("thead th")[[...row.children].indexOf(cell)]
        ?.textContent ?? "",
    );
    const pill = textNode("span", "status-pill", label);
    pill.setAttribute("data-tone", tone);
    cell.append(pill);
  }

  /**
   * @param {string} label
   * @param {string} name
   * @param {string} type
   * @param {string} autocomplete
   * @param {string} [inputMode]
   */
  function formField(label, name, type, autocomplete, inputMode) {
    const wrapper = node("label", "form-field");
    wrapper.append(textNode("span", "", label));
    const input = documentObject.createElement("input");
    input.name = name;
    input.type = type;
    input.setAttribute("autocomplete", autocomplete);
    input.required = true;
    if (inputMode !== undefined) {
      input.inputMode = inputMode;
    }
    wrapper.append(input);
    return wrapper;
  }

  /**
   * @param {string} placeholder
   * @param {string} field
   * @param {string} value
   */
  function filterInput(placeholder, field, value) {
    const input = documentObject.createElement("input");
    input.type = "search";
    input.placeholder = placeholder;
    input.value = value;
    input.setAttribute("aria-label", placeholder);
    input.setAttribute("data-filter", field);
    return input;
  }

  /**
   * @param {string} label
   * @param {string} field
   * @param {string} value
   * @param {Array<[string, string]>} choices
   */
  function filterSelect(label, field, value, choices) {
    const select = documentObject.createElement("select");
    select.setAttribute("aria-label", label);
    select.setAttribute("data-filter", field);
    for (const [choiceValue, choiceLabel] of choices) {
      const option = documentObject.createElement("option");
      option.value = choiceValue;
      option.textContent = choiceLabel;
      select.append(option);
    }
    select.value = value;
    return select;
  }

  /**
   * @param {string} label
   * @param {string} variant
   */
  function actionButton(label, variant) {
    const button = documentObject.createElement("button");
    button.type = "button";
    button.className = `button button-${variant}`;
    button.textContent = label;
    return button;
  }

  /**
   * @param {string} message
   * @param {string} tone
   */
  function messageBanner(message, tone) {
    const banner = textNode("div", "message-banner", message);
    banner.setAttribute("role", tone === "danger" ? "alert" : "status");
    banner.setAttribute("data-tone", tone);
    return banner;
  }

  /**
   * @param {string} message
   */
  function emptyState(message) {
    return textNode("p", "empty-state", message);
  }

  /**
   * @param {keyof HTMLElementTagNameMap} tag
   * @param {string} className
   */
  function node(tag, className) {
    const element = documentObject.createElement(tag);
    if (className !== "") {
      element.className = className;
    }
    return element;
  }

  /**
   * @param {keyof HTMLElementTagNameMap} tag
   * @param {string} className
   * @param {string} text
   */
  function textNode(tag, className, text) {
    const element = node(tag, className);
    element.textContent = text;
    return element;
  }

  return {
    sectionHeading,
    panel,
    baseTable,
    tableBody,
    appendCell,
    appendPillCell,
    formField,
    filterInput,
    filterSelect,
    actionButton,
    messageBanner,
    emptyState,
    node,
    textNode,
  };
}
