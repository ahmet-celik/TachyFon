'use strict';

/*
 * Copyright 2014 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */


/**
 * Incremental font loader utilities.
 */
var IncrementalFontUtils = {};


/**
 * Enum for flags in the coming glyph bundle
 * @enum {number}
 */
IncrementalFontUtils.FLAGS = {
    HAS_HMTX: 1,
    HAS_VMTX: 2,
    HAS_CFF: 4
};

/**
 * Segment size in the loca table
 * @const {number}
 */
IncrementalFontUtils.LOCA_BLOCK_SIZE = 64;

/**
 * The Style Sheet ID
 * @const {number}
 */
IncrementalFontUtils.STYLESHEET_ID = 'Incremental\u00A0Font\u00A0Utils';

/**
 * Inject glyphs in the glyphData to the baseFont
 * @param {Object} obj The object with the font header information.
 * @param {DataView} baseFont Current base font
 * @param {ArrayBuffer} glyphData New glyph data
 * @return {ArrayBuffer} Updated base font
 */
IncrementalFontUtils.injectCharacters = function(obj, baseFont,
  glyphData) {
  // time_start('inject')
  obj.dirty = true;
  var bundleBinEd = new BinaryFontEditor(new DataView(glyphData), 0);
  var baseBinEd = new BinaryFontEditor(baseFont, 0);

  var count = bundleBinEd.getUint16_();
  var flags = bundleBinEd.getUint8_();

  var isCFF = flags & IncrementalFontUtils.FLAGS.HAS_CFF;
  for (var i = 0; i < count; i += 1) {
    var id = bundleBinEd.getUint16_();
    var hmtx, vmtx;
    if (flags & IncrementalFontUtils.FLAGS.HAS_HMTX) {
        hmtx = bundleBinEd.getUint16_();
        baseBinEd.setMtxSideBearing(obj.hmtxOffset, obj.hmetricCount,
            id, hmtx);
    }
    if (flags & IncrementalFontUtils.FLAGS.HAS_VMTX) {
        vmtx = bundleBinEd.getUint16_();
        baseBinEd.setMtxSideBearing(obj.vmtxOffset, obj.vmetricCount,
            id, vmtx);
    }
    var offset = bundleBinEd.getUint32_();
    var length = bundleBinEd.getUint16_();

    if (!isCFF) {
      baseBinEd.setGlyphDataOffset(obj.glyphDataOffset, obj.offsetSize,
        id, offset);
      var oldNextOne = baseBinEd.getGlyphDataOffset(obj.glyphDataOffset,
      obj.offsetSize, id + 1);
      var newNextOne = offset + length;
      var isChanged = oldNextOne != newNextOne;
      baseBinEd.setGlyphDataOffset(obj.glyphDataOffset, obj.offsetSize,
        id + 1, newNextOne);
      var prev_id = id - 1;
      while (prev_id >= 0 && baseBinEd.getGlyphDataOffset(obj.glyphDataOffset,
        obj.offsetSize, prev_id) > offset) {

        baseBinEd.setGlyphDataOffset(obj.glyphDataOffset, obj.offsetSize,
            prev_id, offset);
        prev_id--;
      }
      /*
       * if value is changed and length is nonzero we should write -1
       */
      if (isChanged) {
        baseBinEd.seek(obj.glyphOffset + newNextOne);
        if (length > 0) {
          baseBinEd.setInt16_(-1);
        }else if (length == 0) {
           /*if it is still zero,then could write -1*/
          var currentUint1 = baseBinEd.getUint32_(),
              currentUint2 = baseBinEd.getUint32_();
          if (currentUint1 == 0 && currentUint2 == 0) {
            baseBinEd.seek(obj.glyphOffset + newNextOne);
            baseBinEd.setInt16_(-1);
          }
        }
      }
    } else {
      baseBinEd.setGlyphDataOffset(obj.glyphDataOffset, obj.offsetSize,
        id, offset);
      var oldNextOne = baseBinEd.getGlyphDataOffset(obj.glyphDataOffset,
        obj.offsetSize, id + 1);
      baseBinEd.setGlyphDataOffset(obj.glyphDataOffset, obj.offsetSize, id + 1,
        offset + length);
      var nextId = id + 2;
      var offsetCount = obj.numGlyphs + 1;
      var currentIdOffset = offset + length, nextIdOffset;
      if (oldNextOne < currentIdOffset && nextId - 1 < offsetCount - 1) {
        baseBinEd.seek(obj.glyphOffset + currentIdOffset);
        baseBinEd.setUint8_(14);
      }
      while (nextId < offsetCount) {
          nextIdOffset = baseBinEd.getGlyphDataOffset(obj.glyphDataOffset,
            obj.offsetSize, nextId);
          if (nextIdOffset <= currentIdOffset) {
            currentIdOffset++;
            baseBinEd.setGlyphDataOffset(obj.glyphDataOffset, obj.offsetSize,
                nextId, currentIdOffset);
            if (nextId < offsetCount - 1) {
                baseBinEd.seek(obj.glyphOffset + currentIdOffset);
                baseBinEd.setUint8_(14);
            }
            nextId++;
          } else {
              break;
          }
      }
    }

    var bytes = bundleBinEd.getArrayOf_(bundleBinEd.getUint8_, length);
    baseBinEd.seek(obj.glyphOffset + offset);
    baseBinEd.setArrayOf_(baseBinEd.setUint8_, bytes);
  }
  // time_end('inject')

  return baseFont;
};

/**
 * Parses base font header, set properties.
 * @param {DataView} baseFont Base font with header.
 * @param {Object} headerInfo Header information
 */
IncrementalFontUtils.writeCmap12 = function(baseFont, headerInfo) {
    if (!headerInfo.cmap12)
        return;
    var binEd = new BinaryFontEditor(baseFont, headerInfo.cmap12.offset + 16);
    var nGroups = headerInfo.cmap12.nGroups;
    var segments = headerInfo.compact_gos.cmap12.segments;
    for (var i = 0; i < nGroups; i++) {
        binEd.setUint32_(segments[i][0]);
        binEd.setUint32_(segments[i][0] + segments[i][1] - 1);
        binEd.setUint32_(segments[i][2]);
    }
};

/**
 * Parses base font header, set properties.
 * @param {DataView} baseFont Base font with header.
 * @param {Object} headerInfo Header information
 */
IncrementalFontUtils.writeCmap4 = function(baseFont, headerInfo) {
    if (!headerInfo.cmap4)
        return;
    var segments = headerInfo.compact_gos.cmap4.segments;
    var glyphIdArray = headerInfo.compact_gos.cmap4.glyphIdArray;
    var binEd = new BinaryFontEditor(baseFont, headerInfo.cmap4.offset + 6);
    var segCount = binEd.getUint16_() / 2;
    var glyphIdArrayLen = (headerInfo.cmap4.length - 16 - segCount * 8) / 2;
    headerInfo.cmap4.segCount = segCount;
    headerInfo.cmap4.glyphIdArrayLen = glyphIdArrayLen;
    binEd.skip(6); //skip searchRange,entrySelector,rangeShift
    for (var i = 0; i < segCount; i++) {
        binEd.setUint16_(segments[i][1]);
    }
    binEd.skip(2);//skip reservePad
    for (var i = 0; i < segCount; i++) {
        binEd.setUint16_(segments[i][0]);
    }
    for (var i = 0; i < segCount; i++) {
        binEd.setUint16_(segments[i][2]);
    }
    for (var i = 0; i < segCount; i++) {
        binEd.setUint16_(segments[i][3]);
    }
    if (glyphIdArrayLen > 0)
        binEd.setArrayOf_(binEd.setUint16_, glyphIdArray);
};

/**
 * Parses base font header, set properties.
 * @param {DataView} baseFont Base font with header.
 * @param {Object} headerInfo Header information
 */
IncrementalFontUtils.writeCharsetFormat2 = function(baseFont, headerInfo) {
    if (!headerInfo.charset_fmt)
        return;
    var binEd = new BinaryFontEditor(baseFont,
                                        headerInfo.charset_fmt.offset + 1);
    var nGroups = headerInfo.charset_fmt.gos.len;
    var segments = headerInfo.charset_fmt.gos.segments;
    var is_fmt_2 = (headerInfo.charset_fmt.gos.type == 6);
    for (var i = 0; i < nGroups; i++) {
        binEd.setUint16_(segments[i][0]);
        if(is_fmt_2)
            binEd.setUint16_(segments[i][1]);
        else
            binEd.setUint8_(segments[i][1]);
    }
};

/**
 * Parses base font header, set properties.
 * @param {DataView} baseFont Base font with header.
 * @return {Object} The header information.
 */
IncrementalFontUtils.parseBaseHeader = function(baseFont) {

    var binEd = new BinaryFontEditor(baseFont, 0);
    var results = binEd.parseBaseHeader();
    if (!results.headSize) {
      throw 'missing header info';
    }
    return results;
};


/**
 * Send a log message to the server
 * @param {String} url The url of the Incremental Font server.
 * @param {String} msg The message to log.
 * @return {Promise} Promise to return ArrayBuffer for the response bundle
 */
IncrementalFontUtils.logger = function(url, msg) {

  return IncrementalFontUtils.requestURL(
    url + '/incremental_fonts/logger',
    'POST',
    msg,
    // Google App Engine servers do not support CORS so we cannot say
    // the 'Content-Type' is 'application/json'.
    //{'Content-Type': 'application/json'},
    {'Content-Type': 'text/plain'},
    'text');
};


/**
 * Request codepoints from server
 * @param {String} url The url of the Incremental Font server.
 * @param {String} fontname The fontname.
 * @param {Array.<number>} codes Codepoints to be requested
 * @return {Promise} Promise to return ArrayBuffer for the response bundle
 */
IncrementalFontUtils.requestCodepoints = function(url, fontname, codes) {

  var bandwidth = ForDebug.getCookie('bandwidth', '0');
  return IncrementalFontUtils.requestURL(
    url + '/incremental_fonts/request',
    'POST',
    JSON.stringify({'font': fontname, 'arr': codes}),
    // Google App Engine servers do not support CORS so we cannot say
    // the 'Content-Type' is 'application/json'.
    //{'Content-Type': 'application/json'},
    {'Content-Type': 'text/plain', 'X-TachyFon-bandwidth': bandwidth},
    'arraybuffer');
};


//var fetchCnt = 0;
/**
 * Async XMLHttpRequest to given url using given method, data and header
 * @param {string} url Destination url
 * @param {string} method Request method
 * @param {type} data Request data
 * @param {Object} headerParams Request headers
 * @param {string} responseType Response type
 * @return {Promise} Promise to return response
 */
IncrementalFontUtils.requestURL = function(url, method, data, headerParams, 
                                           responseType) {
  //var cnt = fetchCnt++;
  //timer1.start('fetch ' + cnt + ' ' + url);
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    for (var param in headerParams)
      xhr.setRequestHeader(param, headerParams[param]);
    xhr.responseType = responseType;
    xhr.onload = function(oEvent) {
      if (xhr.status == 200) {
        //timer1.end('fetch ' + cnt + ' ' + url);
        resolve(xhr.response);
      } else
        reject(xhr.status + ' ' + xhr.statusText);
    };
    xhr.onerror = function() {
      reject(Error('Network Error'));
    };
    xhr.send(data);
  });
};


/**
 * Sanitize base font to pass OTS
 * @param {Object} obj The object with the font header information.
 * @param {DataView} baseFont Base font as DataView
 * @return {ArrayBuffer} Sanitized base font
 */
IncrementalFontUtils.sanitizeBaseFont = function(obj, baseFont) {

  if (obj.isTTF) {
    obj.dirty = true;
    var binEd = new BinaryFontEditor(baseFont, 0);
    var glyphOffset = obj.glyphOffset;
    var glyphCount = obj.numGlyphs;
    var glyphSize, thisOne, nextOne;
    for (var i = (IncrementalFontUtils.LOCA_BLOCK_SIZE - 1); i < glyphCount;
    i += IncrementalFontUtils.LOCA_BLOCK_SIZE) {
        thisOne = binEd.getGlyphDataOffset(obj.glyphDataOffset,
        obj.offsetSize, i);
        nextOne = binEd.getGlyphDataOffset(obj.glyphDataOffset,
        obj.offsetSize, i + 1);
      glyphSize = nextOne - thisOne;
      if (glyphSize) {
          binEd.seek(glyphOffset + thisOne);
          binEd.setInt16_(-1);
      }
    }
  } else {
    obj.dirty = true;
    var binEd = new BinaryFontEditor(baseFont, 0);
    var glyphOffset = obj.glyphOffset;
    var glyphCount = obj.numGlyphs;
    var lastRealOffset = binEd.getGlyphDataOffset(obj.glyphDataOffset,
            obj.offsetSize, 0);
    var delta = 0, thisOne;
    for (var i = 0; i < glyphCount + 1; i++) {
        thisOne = binEd.getGlyphDataOffset(obj.glyphDataOffset,
         obj.offsetSize, i);
        if (lastRealOffset == thisOne) {
            thisOne = lastRealOffset + delta;
            binEd.setGlyphDataOffset(obj.glyphDataOffset,
                obj.offsetSize, i, thisOne);
            delta++;
        } else {
            lastRealOffset = thisOne;
            delta = 1;
        }
        if (i < glyphCount) {
            binEd.seek(glyphOffset + thisOne);
            binEd.setUint8_(14);
        }
    }
  }
  return baseFont;
};

/**
 * Add and load the font
 * @param {String} fontname The fontname
 * @param {string} font_src Data url of the font
 * @param {function()} callback Action to take when font is loaded
 */
IncrementalFontUtils.setTheFont = function(fontname, font_src, callback) {
  var font = new FontFace(fontname, 'url(' + font_src + ')', {});
  document.fonts.add(font);
  font.load().then(callback);
};

/**
 * Set a style's visibility.
 * @param {Object} style The style object
 * @param {string} fontname name of the font
 * @param {boolean} visible True is setting visibility to visible.
 * @return {style} New style object for given font and visibility
 */
IncrementalFontUtils.setVisibility = function(style, fontname, visible) {
  if (!style) {
    style = document.createElement('style');
    document.head.appendChild(style);
  }
  if (style.sheet.cssRules.length) {
    style.sheet.deleteRule(0);
  }
  var visibility;
  if (visible) {
    visibility = 'visible';
  } else {
    visibility = 'hidden';
  }
  var rule = '.' + fontname + ' { font-family: ' + fontname + '; ' +
    'visibility: ' + visibility + '; }';

  style.sheet.insertRule(rule, 0);

  return style;
};

/**
 * Add the '@font-face' rule
 * @param {string} fontname The CSS fontname
 * @param {Array} data The font data.
 * @param {boolean} isTTF True is the font is of type TTF.
 */
IncrementalFontUtils.setFont = function(fontname, data, isTTF, msg) {
  timer1.start(msg);
  var mime_type = '';
  if (isTTF) {
    mime_type = 'font/ttf'; // 'application/x-font-ttf';
  } else {
    mime_type = 'font/otf'; // 'application/font-sfnt';
  }

  var blob;
  try {
    blob = new Blob([data], { type: mime_type });
  } catch (e) {
    // IE 11 does not like using DataView here.
    if (e.name == 'InvalidStateError') {
      var buffer = data.buffer.slice(data.byteOffset);
      blob = new Blob([buffer], { type: mime_type});
    }
  }
  var blobUrl = window.URL.createObjectURL(blob);

  if (typeof FontFace == 'undefined') {
    IncrementalFontUtils.setFont_oldStyle(fontname, blobUrl, isTTF)
    return;
  } else {
    var font = new FontFace(fontname, 'url(' + blobUrl + ')', {});
    document.fonts.add(font);
    font.load();
  }
};


/**
 * Add the '@font-face' rule without using CSS Fonts Module Level 3.
 * @param {string} fontname The CSS fontname
 * @param {string} blobUrl The blob URL of the font data.
 * @param {boolean} isTTF True is the font is of type TTF.
 */
IncrementalFontUtils.setFont_oldStyle = function(fontname, blobUrl, isTTF) {
  // Get the style sheet.
  var style = document.getElementById(IncrementalFontUtils.STYLESHEET_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = IncrementalFontUtils.STYLESHEET_ID;
    document.head.appendChild(style);
  }
  var sheet = style.sheet;

  // Delete the rule for this font (if it exists).
  var rule_to_delete = -1;
  var rules = sheet.cssRules || sheet.rules;
  if (rules) {
    for (var i = 0; i < rules.length; i++) {
      var this_rule = rules[i];
      if (this_rule.type == CSSRule.FONT_FACE_RULE) {
        //console.log('found an @font-face rule');
        var style = this_rule.style;
        var font_family = style.getPropertyValue('font-family');
        // TODO(bstell) consider using weight/slant.
        if (font_family == fontname) {
          rule_to_delete = i;
          break;
        }
      }
    }
  }

  var format;
  if (isTTF) {
    format = 'truetype';
  } else {
    format = 'opentype';
  }
  var rule_str = '@font-face {\n' +
    '    font-family: ' + fontname + ';\n' +
    '    src: url("' + blobUrl + '")' + 
    ' format("' + format + '")' + 
    ';' +
    '}';

  sheet.insertRule(rule_str, sheet.cssRules.length);

  if (rule_to_delete >= 0) {
    if (sheet.deleteRule) {
      sheet.deleteRule(rule_to_delete);
    } else if (sheet.removeRule) {
      sheet.removeRule(rule_to_delete);
    } else {
      console.log('no delete/drop rule');
    }
  }

};


/**
 * Add the '@font-face' rule
 * @param {string} fontname The CSS fontname
 * @param {string} url The url of the webfont.
 * @param {string} fonttype The type of the font; eg truetype or opentype.
 */
IncrementalFontUtils.loadWebFont = function(fontname, fonturl, fonttype) {
  timer2.start('load web font');
  var timeout_id;
  function font_loading_timeout() {
    timer2.end('load web font');
    timeout_id = setTimeout(font_loading_timeout, 100);
  }
  font_loading_timeout();

  var bandwidth = ForDebug.getCookie('bandwidth', '0');
  if (true || typeof window.FontFace == 'undefined') {
    var style = document.createElement('style');
    document.head.appendChild(style);
    var sheet = style.sheet;
    var rule_str = 
      '@font-face {\n' +
      '    font-family: "' + fontname + '";\n' + 
      '    src: url("' + fonturl + "?bandwidth=" + bandwidth + 
      '&ts=' + Date.now() + '") format("' + fonttype + '")\n' +
      '}';
    sheet.insertRule(rule_str, 0);
    // A lazy way to time the web font.
    window.addEventListener("load", function(event) {
      clearTimeout(timeout_id);
      timer2.end('load web font');
    });


  	return;
  }

  var face = new FontFace(fontname, "url(" + fonturl + 
    "?bandwidth=" + bandwidth + '&ts=' + Date.now() + ")", {});
  face.load().then(function (loadedFace) {
    document.fonts.add(loadedFace);
    document.body.style.fontFamily = fontname;
    timer2.end('load web font:<br>' + fontname);
    clearTimeout(timeout_id);
  });
  return face;
}

