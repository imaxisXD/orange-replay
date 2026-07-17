import { stringifyRule } from "../../rrweb-snapshot/index.ts";
import type {
  elementNode,
  serializedNodeWithId,
  adoptedStyleSheetCallback,
  adoptedStyleSheetParam,
  attributeMutation,
  mutationCallBack,
} from "../../rrweb-types/index.ts";
import { StyleSheetMirror } from "../utils";

type StyleSheetHost = Document | ShadowRoot;

interface StyleSheetAdopter {
  emitted: boolean;
  hostId: number;
  sheets: Set<CSSStyleSheet>;
  shouldRecord: () => boolean;
}

export class StylesheetManager {
  private mutationCb: mutationCallBack;
  private adoptedStyleSheetCb: adoptedStyleSheetCallback;
  private adopters = new Map<StyleSheetHost, StyleSheetAdopter>();
  private adoptersBySheet = new Map<CSSStyleSheet, Set<StyleSheetHost>>();
  public styleMirror = new StyleSheetMirror();

  constructor(options: {
    mutationCb: mutationCallBack;
    adoptedStyleSheetCb: adoptedStyleSheetCallback;
  }) {
    this.mutationCb = options.mutationCb;
    this.adoptedStyleSheetCb = options.adoptedStyleSheetCb;
  }

  public attachLinkElement(_linkElement: HTMLLinkElement, childSn: serializedNodeWithId) {
    if ("_cssText" in (childSn as elementNode).attributes)
      this.mutationCb({
        adds: [],
        removes: [],
        texts: [],
        attributes: [
          {
            id: childSn.id,
            attributes: (childSn as elementNode).attributes as attributeMutation["attributes"],
          },
        ],
      });
  }

  public adoptStyleSheets(
    sheets: CSSStyleSheet[] | readonly CSSStyleSheet[],
    hostId: number,
    options?: { host: StyleSheetHost; shouldRecord: () => boolean },
  ) {
    if (options !== undefined) {
      this.trackAdopters(options.host, sheets, hostId, options.shouldRecord);
    }
    if (sheets.length === 0 || hostId <= 0 || options?.shouldRecord() === false) return;
    this.emitAdoptedStyleSheets(sheets, hostId);
    if (options !== undefined) {
      const adopter = this.adopters.get(options.host);
      if (adopter !== undefined) adopter.emitted = true;
    }
  }

  /**
   * A constructed sheet may be shared by several roots. Record its mutation
   * only while at least one current adopter is allowed to be captured.
   */
  public prepareAdoptedSheetMutation(sheet: CSSStyleSheet): boolean {
    const hosts = this.adoptersBySheet.get(sheet);
    if (hosts === undefined) return false;
    for (const host of hosts) {
      const adopter = this.adopters.get(host);
      if (adopter === undefined || adopter.hostId <= 0 || !adopter.shouldRecord()) continue;
      if (!adopter.emitted || !this.styleMirror.has(sheet)) {
        this.emitAdoptedStyleSheets([...adopter.sheets], adopter.hostId);
        adopter.emitted = true;
      }
      return this.styleMirror.has(sheet);
    }
    return false;
  }

  public removeAdopter(host: StyleSheetHost): void {
    const current = this.adopters.get(host);
    if (current === undefined) return;
    for (const sheet of current.sheets) {
      const hosts = this.adoptersBySheet.get(sheet);
      hosts?.delete(host);
      if (hosts?.size === 0) this.adoptersBySheet.delete(sheet);
    }
    this.adopters.delete(host);
  }

  private trackAdopters(
    host: StyleSheetHost,
    sheets: readonly CSSStyleSheet[],
    hostId: number,
    shouldRecord: () => boolean,
  ): void {
    this.removeAdopter(host);
    const sheetSet = new Set(sheets);
    this.adopters.set(host, { emitted: false, hostId, sheets: sheetSet, shouldRecord });
    for (const sheet of sheetSet) {
      const hosts = this.adoptersBySheet.get(sheet) ?? new Set<StyleSheetHost>();
      hosts.add(host);
      this.adoptersBySheet.set(sheet, hosts);
    }
  }

  private emitAdoptedStyleSheets(
    sheets: CSSStyleSheet[] | readonly CSSStyleSheet[],
    hostId: number,
  ): void {
    const adoptedStyleSheetData: adoptedStyleSheetParam = {
      id: hostId,
      styleIds: [] as number[],
    };
    const styles: NonNullable<adoptedStyleSheetParam["styles"]> = [];
    for (const sheet of sheets) {
      let styleId;
      if (!this.styleMirror.has(sheet)) {
        styleId = this.styleMirror.add(sheet);
        styles.push({
          styleId,
          rules: Array.from(sheet.rules || CSSRule, (r, index) => ({
            rule: stringifyRule(r, sheet.href),
            index,
          })),
        });
      } else styleId = this.styleMirror.getId(sheet);
      adoptedStyleSheetData.styleIds.push(styleId);
    }
    if (styles.length > 0) adoptedStyleSheetData.styles = styles;
    this.adoptedStyleSheetCb(adoptedStyleSheetData);
  }

  public reset() {
    this.styleMirror.reset();
    this.adopters.clear();
    this.adoptersBySheet.clear();
  }
}
