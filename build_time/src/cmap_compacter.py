"""
  Copyright 2014 Google Inc. All rights reserved.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
"""
from fontTools_wrapper_funcs import change_method,_decompile_in_cmap_format_12_13,\
  _decompile_in_cmap_format_4
from fontTools.ttLib.tables import _c_m_a_p
import struct
import bitarray
from _collections import defaultdict
from fontTools.cffLib import readCard8, readCard16


def generateDeltaArray(input_arr):
  """generates delta array for given array
  e.g. [4,12,15,22] -> [4,8,3,7]
  """
  input_len = len(input_arr)
  assert input_len > 0, 'Empty array is given'
  deltas = [None] * input_len
  deltas[0] = input_arr[0]
  idx = 1
  while idx < input_len:
    deltas[idx] = input_arr[idx]-input_arr[idx-1]
    idx+=1
  return deltas

def add_to_extra_if_necessary(gos_data, extra_data, delta_code_result):
  """Checks if number is too big to fit GOS, then add it to correct stream
  """
  if type(delta_code_result) is tuple:
    escape_str, number = delta_code_result
    gos_data.extend(escape_str)
    non_repr = NumberEncoders.NoNString(number)
    extra_data.extend(non_repr)
  else:
    gos_data.extend(delta_code_result)
      
class NumberEncoders(object):

  @staticmethod
  def NibbleBin(number):
    """Converts given number to binary using enough nibbles
    16 -> (2,'00010000')
    """
    assert number >= 0,'takes only non-negative numbers'
    if number == 0:
      return (1,'0000')
    count = 0
    copy_number = number
    while copy_number:
      copy_number >>= 4
      count += 1
    return (count,bin(number)[2:].zfill(count*4))
        
  @staticmethod
  def NoNString(number):
    """Encode number using nibbles.
    First nibbles is the number of nibbles needed. For non-negative numbers
    it one less than nibble count, for negative numbers it is seven more than
    nibble count
    0<=first_nibble<8 : non-negative number
    8<=first_nibble<16: negative number
    -17 -> 100100010001  0x911 nibble count: 9-7=2
     17 -> 000100010001  0x111 nibble count: 1+1=2
    """
    count, number_bin_str = NumberEncoders.NibbleBin(abs(number))
    if number >= 0:
      count -= 1
    else:
      count += 7
    nibble_count_bin_str = NumberEncoders.NibbleBin(count)[1]
    return nibble_count_bin_str + number_bin_str
      
  @staticmethod
  def AOE(number, bit_count):
    """Binary string of given number using given bit count 
      or escape it using all ones
    (12,5) -> 01100
    (12,3) -> (111,12)
    (-1,2) -> (11,-1)
    """
    if number < 0: #escape negative numbers
      return ('1' * bit_count , number)
    elif number < 2 ** bit_count - 1:
      return bin(number)[2:].zfill(bit_count)
    else:
      return ('1' * bit_count , number)


class _GOSGenerators(object):
  
  @staticmethod
  def type6_7(font):
    cffTableOffset = font.reader.tables['CFF '].offset
    cffTable = font['CFF '].cff
    assert len(cffTable.fontNames) == 1 #only one font should be present
    charsetOffset = cffTable[cffTable.fontNames[0]].rawDict['charset']
    numGlyphs = font['maxp'].numGlyphs
    inner_file = font.reader.file
    inner_file.seek(cffTableOffset+charsetOffset)
    format = readCard8(inner_file);
    if format != 2 and format != 1:
      return None
    seenGlyphCount = 0
    firstArr = []
    nLeftArr = []
    while seenGlyphCount < numGlyphs:
      first = readCard16(inner_file)
      if format == 2:
        nLeft = readCard16(inner_file)
      elif format == 1:
        nLeft = readCard8(inner_file)
      firstArr.append(first)
      nLeftArr.append(nLeft)
      seenGlyphCount += nLeft + 1
    rangeCount = len(firstArr)
    #print 'charset size',rangeCount*4+1,'bytes'
    gos_data = bitarray.bitarray(endian='big')
    extra_data = bitarray.bitarray(endian='big')
    gos_data.frombytes(struct.pack('>L',cffTableOffset+charsetOffset))
    if format == 2:
      gos_data.frombytes(struct.pack('>B',6)) #format 2
    elif format == 1:
      gos_data.frombytes(struct.pack('>B',7)) #format 1
    gos_data.frombytes(struct.pack('>H',rangeCount))
    deltaFirst = generateDeltaArray(firstArr)
    deltaNLeft = generateDeltaArray(nLeftArr)
    for idx in xrange(rangeCount):
      first_enc = NumberEncoders.AOE(deltaFirst[idx],5)
      add_to_extra_if_necessary(gos_data, extra_data, first_enc)
      nLeft_enc = NumberEncoders.AOE(deltaNLeft[idx],3)
      add_to_extra_if_necessary(gos_data, extra_data, nLeft_enc)
    
    whole_data = gos_data.tobytes() + extra_data.tobytes()
    #print 'type6 size',len(whole_data)
    return whole_data       
    
  
  @staticmethod
  def type5(font):
    old_12_method = change_method(_c_m_a_p.cmap_format_12_or_13,_decompile_in_cmap_format_12_13, 'decompile')
    cmapTable = font['cmap']
    cmap12 = cmapTable.getcmap(3, 10).cmap #format 12
    assert cmap12,'cmap format 12 table is needed'
    ourData = cmap12
    nGroups = len(ourData['startCodes'])
    gos_data = bytearray()
    gos_data.extend(struct.pack('>B',5))
    gos_data.extend(struct.pack('>H',nGroups))
    for i in xrange(nGroups):
      gos_data.extend(struct.pack('>LLL',ourData['startCodes'][i],ourData['lengths'][i],ourData['gids'][i]))
    change_method(_c_m_a_p.cmap_format_12_or_13,old_12_method,'decompile')
    #print 'type5 size',len(gos_data)
    return gos_data

  @staticmethod
  def type4(font):
    old_12_method = change_method(_c_m_a_p.cmap_format_12_or_13,_decompile_in_cmap_format_12_13, 'decompile')
    old_4_method = change_method(_c_m_a_p.cmap_format_4,_decompile_in_cmap_format_4, 'decompile')
    cmapTable = font['cmap']
    cmap12 = cmapTable.getcmap(3, 10).cmap #format 12
    cmap4 = cmapTable.getcmap(3, 1).cmap #format 4
    assert cmap12 and cmap4, 'Both cmap format 12 and 4 tables are needed'
    

    cmap4_endCodes = cmap4['endCode']
    cmap4_startCodes = cmap4['startCode']
    cmap12_startCodes = cmap12['startCodes']
    cmap12_lengths = cmap12['lengths']
    
    fmt12SegCount = len(cmap12_startCodes)
    fmt4SegCount = len(cmap4_startCodes) - 1 # Don't compare 0xFFFF
    


    
    #finds segment mappings
    fmt4Seg = 0
    fmt12Seg = 0
    mapping = defaultdict(list)
    while fmt12Seg < fmt12SegCount and fmt4Seg < fmt4SegCount:
      
      cmap12SegStart = cmap12_startCodes[fmt12Seg]
      cmap12SegEnd = cmap12_startCodes[fmt12Seg] + cmap12_lengths[fmt12Seg] - 1
      cmap4SegStart =cmap4_startCodes[fmt4Seg]
      cmap4SegEnd = cmap4_endCodes[fmt4Seg]
      
      if cmap12SegStart>= cmap4SegStart  and cmap12SegEnd <= cmap4SegEnd:
        mapping[fmt4Seg].append(fmt12Seg)
        fmt12Seg += 1
      elif cmap12SegStart  > cmap4_endCodes[fmt4Seg]:
        fmt4Seg += 1
      else:
        #case of where format12 segment overlap end of format4 segment
        print cmap12SegStart,cmap12SegEnd,cmap4_startCodes[fmt4Seg],cmap4_endCodes[fmt4Seg]
        raise('unexpected tables')
    assert fmt4Seg >= fmt4SegCount - 2, 'all format 4 segments consumed,possibly except last one(startCode0xFFFF)'
    gos_data = bitarray.bitarray(endian='big')
    extra_data = bitarray.bitarray(endian='big')
    gos_data.frombytes(struct.pack('>B',4)) #GOS type
    gos_data.frombytes(struct.pack('>H',min(fmt4SegCount-1,fmt4Seg+1)))    
    #now checks if segments in good condition
    segLens = []
    idRangeOffsets = cmap4['idRangeOffset']
    idDelta = cmap4['idDelta']

    for fmt4Seg,fmt12SegList in mapping.iteritems():
      lenFmt12Segs = len(fmt12SegList)
      
      cmap12SegStart = cmap12_startCodes[fmt12SegList[0]]
      cmap12SegEnd = cmap12_startCodes[fmt12SegList[-1]] + cmap12_lengths[fmt12SegList[-1]] - 1
      cmap4SegStart =cmap4_startCodes[fmt4Seg]
      cmap4SegEnd = cmap4_endCodes[fmt4Seg]
      
      segLens.append(lenFmt12Segs)
      
      assert cmap12SegStart == cmap4SegStart and cmap12SegEnd == cmap4SegEnd 
      
      if lenFmt12Segs == 1: 
        assert idRangeOffsets[fmt4Seg] == 0
      else: 
        assert idRangeOffsets[fmt4Seg] != 0 and idDelta[fmt4Seg] == 0

    for segLen in segLens:
      enc_len = NumberEncoders.AOE(segLen,2)
      add_to_extra_if_necessary(gos_data, extra_data, enc_len)

    change_method(_c_m_a_p.cmap_format_12_or_13,old_12_method,'decompile')
    change_method(_c_m_a_p.cmap_format_4,old_4_method,'decompile')
    
    whole_data = gos_data.tobytes() + extra_data.tobytes()
    #print 'type4 size',len(whole_data)
    return whole_data
  
  
  @staticmethod
  def type3(font):
    old_12_method = change_method(_c_m_a_p.cmap_format_12_or_13,_decompile_in_cmap_format_12_13, 'decompile')
    cmapTable = font['cmap']
    cmap12 = cmapTable.getcmap(3, 10).cmap #format 12
    assert cmap12,'cmap format 12 table is needed'
    ourData = cmap12
    deltaCodePoints = generateDeltaArray(ourData['startCodes'])
    lengths = ourData['lengths']
    gids = ourData['gids']
    nGroups = len(gids)
    gos_data = bitarray.bitarray(endian='big')
    extra_data = bitarray.bitarray(endian='big')
    gos_data.frombytes(struct.pack('>B',3)) #GOS type
    gos_data.frombytes(struct.pack('>H',nGroups))
    for idx in xrange(nGroups):
      delta_code_result = NumberEncoders.AOE(deltaCodePoints[idx],5)
      add_to_extra_if_necessary(gos_data, extra_data, delta_code_result)
      len_result = NumberEncoders.AOE(lengths[idx],3)
      add_to_extra_if_necessary(gos_data, extra_data, len_result)     
      gid_result = NumberEncoders.AOE(gids[idx],16)
      add_to_extra_if_necessary(gos_data, extra_data, gid_result)
      
    change_method(_c_m_a_p.cmap_format_12_or_13,old_12_method,'decompile')
    
    whole_data = gos_data.tobytes() + extra_data.tobytes()
    #print 'type3 size',len(whole_data)
    return whole_data

  @staticmethod
  def type2(font):
    old_12_method = change_method(_c_m_a_p.cmap_format_12_or_13,_decompile_in_cmap_format_12_13, 'decompile')
    cmapTable = font['cmap']
    cmap12 = cmapTable.getcmap(3, 10).cmap #format 12
    assert cmap12,'cmap format 12 table is needed'
    ourData = cmap12
    deltaCodePoints = generateDeltaArray(ourData['startCodes'])
    lengths = ourData['lengths']
    deltaGids = generateDeltaArray(ourData['gids'])
    nGroups = len(deltaGids)
    gos_data = bitarray.bitarray(endian='big')
    extra_data = bitarray.bitarray(endian='big')
    gos_data.frombytes(struct.pack('>B',2)) #GOS type
    gos_data.frombytes(struct.pack('>H',nGroups))
    for idx in xrange(nGroups):
      delta_code_result = NumberEncoders.AOE(deltaCodePoints[idx],3)
      add_to_extra_if_necessary(gos_data, extra_data, delta_code_result)
      len_result = NumberEncoders.AOE(lengths[idx],2)
      add_to_extra_if_necessary(gos_data, extra_data, len_result)     
      gid_result = NumberEncoders.AOE(deltaGids[idx],3)
      add_to_extra_if_necessary(gos_data, extra_data, gid_result)
      
    change_method(_c_m_a_p.cmap_format_12_or_13,old_12_method,'decompile')
    
    whole_data = gos_data.tobytes() + extra_data.tobytes()
    #print 'type2 size',len(whole_data)
    return whole_data

"""Type of the Group of Segments
Type 7: For CFF CharSet format 1 Table
  first : 5 bit AOE encoding
  nLeft : 3 bit AOE encoding
Type 6: For CFF CharSet format 2 Table
  first : 5 bit AOE encoding
  nLeft : 3 bit AOE encoding
Type 5: For cmap format 12 subtable
  startCode : 32 bit no encoding
  length    : 32 bit no encoding
  gid       : 32 bit no encoding
Type 4: For cmap format 4 subtable
  segListLen: 2 bit AOE encoding, it's mapped format 12 segments count
  Following GOS table, we have extra escaped number table
  using for each number Number of Nibbles(NoN) encoding
Type 3: For cmap format 12 subtable
  startCode(delta) : 5 bit AOE encoding
  length           : 3 bit AOE encoding
  gid              : 16 bit no encoding
  Following GOS table, we have extra escaped number table
  using for each number Number of Nibbles(NoN) encoding
Type 2: For cmap format 12 subtable
  startCode(delta) : 3 bit AOE encoding
  length           : 2 bit AOE encoding
  gid(delta)       : 3 bit AOE encoding
  Following GOS table, we have extra escaped number table
  using for each number Number of Nibbles(NoN) encoding
"""
GOS_Types = {7:_GOSGenerators.type6_7,
             6:_GOSGenerators.type6_7,
             5:_GOSGenerators.type5,
             4:_GOSGenerators.type4,
             3:_GOSGenerators.type3,
             2:_GOSGenerators.type2}


class CmapCompacter(object):

  def __init__(self, font):
    self.font = font
  
  def generateGOSTypes(self,types):
    gos_count = len(types)
    gos_whole_data = bytearray()
    gos_whole_data.extend(struct.pack('>B',gos_count));
    for type in types:
      gos_whole_data.extend(self.generateGOSType(type))
    return gos_whole_data
  
    
  def generateGOSType(self,type):
    assert type in GOS_Types
    return GOS_Types[type](self.font)

    