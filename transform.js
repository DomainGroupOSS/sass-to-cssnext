#!/usr/bin/env node
/* eslint-disable no-param-reassign, no-console, no-template-curly-in-string */
const postcss = require('postcss-scss');
const { camelCase } = require('lodash');
const format = require('prettier-eslint');
const selectorToLiteral = require('./selector-to-literal');

// TODO make CLI option
const FE_BRARY_PREFIX = '$fe-brary-';

function placeHolderToVar(str) {
  return camelCase(str.slice(1));
}

function mixinParamsToFunc(str) {
  const [funcName, inputs] = str.split('(');
  return `${camelCase(funcName)}(${inputs.replace(/\$/g, '')}`;
}

function isNestedInMixin(root, node) {
  let nestedInMixin = false;
  let parentNode = node.parent;
  do {
    if (parentNode !== root && parentNode.type === 'atrule' && parentNode.name === 'mixin') {
      nestedInMixin = true;
    }
    parentNode = parentNode.parent;
  } while (parentNode && parentNode !== root && !nestedInMixin);

  return nestedInMixin;
}

function handleSassVar(decl, root) {
  if (decl.value.startsWith(FE_BRARY_PREFIX)) {
    if (!root.usesFeBraryVars) {
      root.usesFeBraryVars = true;
    }

    const [, name] = decl.value.split(FE_BRARY_PREFIX);
    const [field, ...varNameSegs] = name.split('-');
    const varName = camelCase(varNameSegs.join('-'));
    return `\${vars.${field}.${varName}}`;
  }

  if (decl.value.startsWith('$')) {
    const varName = camelCase(decl.value.slice(1));

    if (isNestedInMixin(root, decl)) {
      return `\${${varName}}`;
    }

    if (!root.usesCustomVars) {
      root.usesCustomVars = true;
    }

    return `\${customVars.${varName}}`;
  }

  return decl.value;
}

const processRoot = (root) => {
  root.classes = new Map();
  root.usesFeBraryVars = false;

  // move all three below to global scope and use stringify
  root.walkAtRules('extend', (atRule) => {
    atRule.params = `\${${placeHolderToVar(atRule.params)}};`;
  });

  root.walkAtRules('include', (atRule) => {
    // check for https://github.com/eduardoboucas/include-media
    if (atRule.nodes && atRule.nodes.length && atRule.params.startsWith('media(')) {
      atRule.name = 'media';

      // $breakpoints: (
      //   'mobile': 320px,
      //   'tablet': $fe-brary-global-tablet-min-width,
      //   'desktop': $fe-brary-global-desktop-min-width,
      //   'lrg-desktop': $fe-brary-global-desktop-max-width
      // );

      // $fe-brary-global-lrg-desktop-min-width: 1441px;
      // $fe-brary-global-desktop-max-width: 1440px;
      // $fe-brary-global-desktop-min-width: 1021px;
      // $fe-brary-global-tablet-max-width: 1020px;
      // $fe-brary-global-tablet-min-width: 624px;
      // $fe-brary-global-mobile-max-width: 623px;
      // $fe-brary-global-mobile-min-width: 0px;

      // https://github.com/eduardoboucas/include-media/blob/master/tests/parse-expression.scss

      let newParam;
      switch (atRule.params) {
        case "media('>mobile')":
          newParam = 'media(min-width: 321px)';
          break;
        case "media('>=mobile')":
          newParam = 'media(min-width: 320px)';
          break;
        case "media('>tablet')":
          newParam = 'media(min-width: ${vars.global.tabletMinWidth + 1})';
          break;
        case "media('>=tablet')":
          newParam = 'media(min-width: ${vars.global.tabletMinWidth})';
          break;
        case "media('>desktop')":
          newParam = 'media(min-width: ${vars.global.desktopMinWidth + 1})';
          break;
        case "media('>=desktop')":
          newParam = 'media(min-width: ${vars.global.desktopMinWidth})';
          break;
        case "media('>lrg-desktop')":
          newParam = 'media(min-width: ${vars.global.desktopMaxWidth + 1})';
          break;
        case "media('>=lrg-desktop')":
          newParam = 'media(min-width: ${vars.global.desktopMaxWidth})';
          break;

        case "media('<mobile')":
          newParam = 'media(max-width: 319px)';
          break;
        case "media('<=mobile')":
          newParam = 'media(max-width: 320px)';
          break;
        case "media('<tablet')":
          newParam = 'media(max-width: ${vars.global.tabletMinWidth - 1})';
          break;
        case "media('<=tablet')":
          newParam = 'media(max-width: ${vars.global.tabletMinWidth})';
          break;
        case "media('<desktop')":
          newParam = 'media(max-width: ${vars.global.desktopMinWidth - 1})';
          break;
        case "media('<=desktop')":
          newParam = 'media(max-width: ${vars.global.desktopMinWidth})';
          break;
        case "media('<lrg-desktop')":
          newParam = 'media(max-width: ${vars.global.desktopMaxWidth - 1})';
          break;
        case "media('<=lrg-desktop')":
          newParam = 'media(max-width: ${vars.global.desktopMaxWidth})';
          break;
        default:
          throw new Error('Found an unrecognised `@include media(..)`, please change it to a vanilla CSS media query that uses fe-brary Sass vars then try this transformer again');
      }

      atRule.params = newParam;

      return;
    }


    const [funcName, inputs] = atRule.params.split('(');
    const funcCall = `${camelCase(funcName)}('${inputs
      .slice(0, -1)
      .split(', ')
      .join("', '")}')`;
    atRule.params = `\${${funcCall}};`;
  });

  root.walkDecls((decl) => {
    decl.value = handleSassVar(decl, root);
  });

  // flattens nested rules
  root.walkRules(/^\./, (rule) => {
    let selector;
    const isPlaceHolder = rule.selector[0] === '%';

    if (isPlaceHolder) {
      selector = placeHolderToVar(rule.selector);
    } else {
      selector = selectorToLiteral(rule.selector);
    }

    if (isNestedInMixin(root, rule)) return;

    let contents = '';
    postcss.stringify(rule, (string, node, startOrEnd) => {
      if (node && node === rule && startOrEnd) return;

      // ignore nested classes
      if (node && node.type === 'rule' && node.selector.startsWith('.')) return;
      if (
        node
        && node.type === 'decl'
        && node.parent !== rule
        && node.parent.type === 'rule'
        && node.parent.selector.startsWith('.')
      ) return;

      if (node && ['extend', 'include'].includes(node.name)) {
        contents += `${node.params}\n`;
        return;
      }

      contents += string;
    });

    root.classes.set(selector, {
      type: isPlaceHolder ? 'placeholder' : 'class',
      contents,
      node: rule,
    });
  });

  root.walkAtRules('mixin', (atRule) => {
    const { params } = atRule;
    const selector = mixinParamsToFunc(params);

    let contents = '';
    postcss.stringify(atRule, (string, node, startOrEnd) => {
      // if node.type === decl skip when doing this above
      // stops first and last part entering the string e.g "@mixin ad-exact($width, $height) {"
      if (node && node === atRule && startOrEnd) return;

      contents += string;
    });

    root.classes.set(selector, {
      type: 'mixin',
      contents,
      node: atRule,
    });
  });
};

module.exports = (cssString, filePath) => {
  const root = postcss.parse(cssString, { from: filePath });

  processRoot(root);

  const emotionExports = Array.from(root.classes.entries())
    .sort(([, { node: a }], [, { node: b }]) => a.source.start.line - b.source.start.line)
    .reduce((acc, [name, { contents, type }]) => {
      if (type === 'mixin') {
        return `${acc}\nfunction ${name} {\n  return css\`${contents}\n  \`;\n}\n`;
      }

      return `${acc}\n${type === 'class' ? 'export ' : ''}const ${name} = css\`${contents}\n\`;\n`;
    }, '');

  const js = `import { css } from 'emotion';\n${
    root.usesFeBraryVars ? "import { variables as vars } from '@domain-group/fe-brary';\n" : ''
  }${
    root.usesCustomVars ? "import customVars from '../variables';\n" : ''
  }${
    emotionExports
  }
`;

  return format({ text: js, filePath, prettierOptions: { parser: 'babylon' } });
};
