import {
  getDateFormatter,
  getDateFormatterSource
} from 'messageformat-date-skeleton';
import {
  getNumberFormatter,
  getNumberFormatterSource
} from 'messageformat-number-skeleton';
import {
  parse,
  FunctionArg,
  Select,
  Token
} from '@messageformat/parser';
import * as Runtime from '@messageformat/runtime';
import * as Formatters from '@messageformat/runtime/lib/formatters';
import { identifier, property } from 'safe-identifier';
import { biDiMarkText } from './bidi-mark-text';
import { MessageFormatOptions } from './messageformat';
import { PluralObject } from './plurals';

const RUNTIME_MODULE = '@messageformat/runtime';
const CARDINAL_MODULE = '@messageformat/runtime/lib/cardinals';
const PLURAL_MODULE = '@messageformat/runtime/lib/plurals';
const FORMATTER_MODULE = '@messageformat/runtime/lib/formatters';

type RuntimeType = 'formatter' | 'locale' | 'runtime';
interface RuntimeEntry {
  (...args: any): string | void;
  module?: string | null;
  toString?: () => string;
  type?: RuntimeType;
}
export interface RuntimeMap {
  [key: string]: Required<RuntimeEntry>;
}

export interface StringStructure {
  [key: string]: StringStructure | string;
}

export default class Compiler {
  arguments: string[] = [];
  options: Required<MessageFormatOptions>;
  // @ts-ignore Always set in compile()
  plural: PluralObject;
  runtime: RuntimeMap = {};

  constructor(options: Required<MessageFormatOptions>) {
    this.options = options;
  }

  /**
   * Recursively compile a string or a tree of strings to JavaScript function
   * sources
   *
   * If `src` is an object with a key that is also present in `plurals`, the key
   * in question will be used as the locale identifier for its value. To disable
   * the compile-time checks for plural & selectordinal keys while maintaining
   * multi-locale support, use falsy values in `plurals`.
   *
   * @param src The source for which the JS code should be generated
   * @param plural The default locale
   * @param plurals A map of pluralization keys for all available locales
   */
  compile(
    src: string | StringStructure,
    plural: PluralObject,
    plurals?: { [key: string]: PluralObject }
  ) {
    if (typeof src === 'object') {
      const result: StringStructure = {};
      for (const key of Object.keys(src)) {
        const pl = (plurals && plurals[key]) || plural;
        result[key] = this.compile(src[key], pl, plurals);
      }
      return result;
    }

    this.plural = plural;
    const parserOptions = {
      cardinal: plural.cardinals,
      ordinal: plural.ordinals,
      strict: this.options.strictNumberSign
    };
    this.arguments = [];
    const r = parse(src, parserOptions).map(token => this.token(token, null));
    let reqArgs = '';
    if (this.options.requireAllArguments && this.arguments.length > 0) {
      this.setRuntimeFn('reqArgs');
      reqArgs = `reqArgs(${JSON.stringify(this.arguments)}, d); `;
    }
    return `function(d) { ${reqArgs}return ${this.concatenate(r, true)}; }`;
  }

  cases(token: Select, pluralToken: Select | null) {
    let needOther = true;
    const r = token.cases.map(({ key, tokens }) => {
      if (key === 'other') needOther = false;
      const s = tokens.map(tok => this.token(tok, pluralToken));
      return `${property(null, key.replace(/^=/, ''))}: ${this.concatenate(
        s,
        false
      )}`;
    });
    if (needOther) {
      const { type } = token;
      const { cardinals, ordinals } = this.plural;
      if (
        type === 'select' ||
        (type === 'plural' && cardinals.includes('other')) ||
        (type === 'selectordinal' && ordinals.includes('other'))
      )
        throw new Error(`No 'other' form found in ${JSON.stringify(token)}`);
    }
    return `{ ${r.join(', ')} }`;
  }

  concatenate(tokens: string[], root: boolean) {
    const asValues = this.options.returnType === 'values';
    return asValues && (root || tokens.length > 1)
      ? '[' + tokens.join(', ') + ']'
      : tokens.join(' + ') || '""';
  }

  token(token: Token, pluralToken: Select | null) {
    if (token.type == 'content') return JSON.stringify(token.value);

    const { id, lc } = this.plural;
    let args: (number | string)[], fn: string;
    if ('arg' in token) {
      this.arguments.push(token.arg);
      args = [property('d', token.arg)];
    } else args = [];
    switch (token.type) {
      case 'argument':
        return this.options.biDiSupport
          ? biDiMarkText(String(args[0]), lc)
          : String(args[0]);

      case 'select':
        fn = 'select';
        if (pluralToken && this.options.strictNumberSign) pluralToken = null;
        args.push(this.cases(token, pluralToken));
        this.setRuntimeFn('select');
        break;

      case 'selectordinal':
        fn = 'plural';
        args.push(token.pluralOffset || 0, id, this.cases(token, token), 1);
        this.setLocale(id, true);
        this.setRuntimeFn('plural');
        break;

      case 'plural':
        fn = 'plural';
        args.push(token.pluralOffset || 0, id, this.cases(token, token));
        this.setLocale(id, false);
        this.setRuntimeFn('plural');
        break;

      case 'function':
        switch (token.key) {
          case 'date':
            fn = this.setDateFormatter(token, args, pluralToken);
            break;
          case 'number':
            fn = this.setNumberFormatter(token, args, pluralToken);
            break;
          default:
            args.push(JSON.stringify(this.plural.locale));
            if (token.param) {
              if (pluralToken && this.options.strictNumberSign)
                pluralToken = null;
              const s = token.param.map(tok => this.token(tok, pluralToken));
              args.push('(' + (s.join(' + ') || '""') + ').trim()');
              if (token.key === 'number')
                args.push(JSON.stringify(this.options.currency));
            }
            fn = token.key;
            this.setFormatter(fn);
        }
        break;

      case 'octothorpe':
        if (!pluralToken) return '"#"';
        args = [
          JSON.stringify(this.plural.locale),
          property('d', pluralToken.arg),
          pluralToken.pluralOffset || 0
        ];
        if (this.options.strictNumberSign) {
          fn = 'strictNumber';
          args.push(JSON.stringify(pluralToken.arg));
          this.setRuntimeFn('strictNumber');
        } else {
          fn = 'number';
          this.setRuntimeFn('number');
        }
        break;
    }

    if (!fn) throw new Error('Parser error for token ' + JSON.stringify(token));
    return `${fn}(${args.join(', ')})`;
  }

  runtimeIncludes(key: string, type: RuntimeType) {
    const prev = this.runtime[key];
    if (!prev || prev.type === type) return prev;
    if (identifier(key) !== key)
      throw new SyntaxError(`Reserved word used as ${type} identifier: ${key}`);
    throw new TypeError(
      `Cannot override ${prev.type} runtime function as ${type}: ${key}`
    );
  }

  setLocale(key: string, ord: boolean) {
    const prev = this.runtimeIncludes(key, 'locale');
    const { getCardinal, getPlural, isDefault } = this.plural;
    let pf: RuntimeEntry, module, toString;
    if (!ord && isDefault && getCardinal) {
      if (prev) return;
      pf = (n: string | number) => getCardinal(n);
      module = CARDINAL_MODULE;
      toString = () => String(getCardinal);
    } else {
      // overwrite a previous cardinal-only locale function
      if (prev && (!isDefault || prev.module === PLURAL_MODULE)) return;
      pf = (n: string | number, ord?: boolean) => getPlural(n, ord);
      module = isDefault ? PLURAL_MODULE : getPlural.module || null;
      toString = () => String(getPlural);
    }
    this.runtime[key] = Object.assign(pf, { module, toString, type: 'locale' });
  }

  setRuntimeFn(
    key: 'number' | 'plural' | 'select' | 'strictNumber' | 'reqArgs'
  ) {
    if (this.runtimeIncludes(key, 'runtime')) return;
    const rf: RuntimeEntry = Runtime[key];
    this.runtime[key] = Object.assign(rf, {
      module: RUNTIME_MODULE,
      type: 'runtime'
    });
  }

  setFormatter(key: string) {
    if (this.runtimeIncludes(key, 'formatter')) return;
    const cf: RuntimeEntry = this.options.customFormatters[key];
    if (cf) {
      this.runtime[key] = Object.assign(cf, {
        module: null,
        type: 'formatter'
      });
    } else if (isFormatterKey(key)) {
      const df: RuntimeEntry = Formatters[key];
      this.runtime[key] = Object.assign(df, {
        module: FORMATTER_MODULE,
        type: 'formatter'
      });
    } else {
      throw new Error(`Formatting function not found: ${key}`);
    }
  }

  setDateFormatter(
    { param }: FunctionArg,
    args: (number | string)[],
    plural: Select | null
  ) {
    const { locale } = this.plural;

    const argStyle = param && param.length === 1 && param[0];
    if (
      argStyle &&
      argStyle.type === 'content' &&
      /^\s*::/.test(argStyle.value)
    ) {
      const argSkeletonText = argStyle.value.trim().substr(2);
      const key = identifier(`date_${locale}_${argSkeletonText}`, true);
      if (!this.runtimeIncludes(key, 'formatter')) {
        const fmt: RuntimeEntry = getDateFormatter(locale, argSkeletonText);
        this.runtime[key] = Object.assign(fmt, {
          module: null,
          toString: () => getDateFormatterSource(locale, argSkeletonText),
          type: 'formatter'
        });
      }
      return key;
    }

    args.push(JSON.stringify(locale));
    if (param && param.length > 0) {
      if (plural && this.options.strictNumberSign) plural = null;
      const s = param.map(tok => this.token(tok, plural));
      args.push('(' + (s.join(' + ') || '""') + ').trim()');
    }
    this.setFormatter('date');
    return 'date';
  }

  setNumberFormatter(
    { param }: FunctionArg,
    args: (number | string)[],
    plural: Select | null
  ) {
    const { locale } = this.plural;

    if (!param) {
      // {var, number} can use runtime number(lc, var, offset)
      args.unshift(JSON.stringify(locale));
      args.push('0');
      this.setRuntimeFn('number');
      return 'number';
    }

    args.push(JSON.stringify(locale));
    if (param.length === 1 && param[0].type === 'content') {
      const fmtArg = param[0].value.trim();

      switch (fmtArg) {
        case 'currency':
          args.push(JSON.stringify(this.options.currency));
          this.setFormatter('numberCurrency');
          return 'numberCurrency';
        case 'integer':
          this.setFormatter('numberInteger');
          return 'numberInteger';
        case 'percent':
          this.setFormatter('numberPercent');
          return 'numberPercent';
      }

      // TODO: Deprecate
      const cm = fmtArg.match(/^currency:([A-Z]+)$/);
      if (cm) {
        args.push(JSON.stringify(cm[1]));
        this.setFormatter('numberCurrency');
        return 'numberCurrency';
      }

      const key = identifier(`number_${locale}_${fmtArg}`, true);
      if (!this.runtimeIncludes(key, 'formatter')) {
        const { currency } = this.options;
        const fmt: RuntimeEntry = getNumberFormatter(locale, fmtArg, currency);
        this.runtime[key] = Object.assign(fmt, {
          module: null,
          toString: () => getNumberFormatterSource(locale, fmtArg, currency),
          type: 'formatter'
        });
      }
      return key;
    }

    if (plural && this.options.strictNumberSign) plural = null;
    const s = param.map(tok => this.token(tok, plural));
    args.push('(' + (s.join(' + ') || '""') + ').trim()');
    args.push(JSON.stringify(this.options.currency));
    this.setFormatter('numberFmt');
    return 'numberFmt';
  }
}

function isFormatterKey(key: string): key is keyof typeof Formatters {
  return key in Formatters;
}
