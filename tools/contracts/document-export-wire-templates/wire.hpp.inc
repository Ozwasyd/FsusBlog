#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include "document_export_wire_primitives.hpp"
namespace FsusBlog::Aeds::DocumentExportWire
{
inline std::size_t PayloadBudget(std::uint16_t frameType)
{
    switch(frameType)
    {
@@BUDGET_CASES@@
        default:return 0;
    }
}
class Reader
{
    const std::uint8_t* data;
    std::size_t length;
    std::size_t offset=0;
public:
    Reader(const std::uint8_t* bytes,std::size_t count):data(bytes),length(count){}
    bool Consumed() const{return offset==length;}
    bool Unsigned(std::size_t width,std::uint64_t& value)
    {
        if(width>length-offset)return false;
        value=0;for(std::size_t i=0;i<width;i++)value|=std::uint64_t(data[offset++])<<(i*8);
        return true;
    }
    bool Int32(std::int32_t& value)
    {
        std::uint64_t raw;if(!Unsigned(4,raw))return false;
        value=raw<=2147483647ULL?static_cast<std::int32_t>(raw):-1-static_cast<std::int32_t>(4294967295ULL-raw);
        return true;
    }
    bool Int64(std::int64_t& value)
    {
        std::uint64_t raw;if(!Unsigned(8,raw))return false;
        value=raw<=9223372036854775807ULL?static_cast<std::int64_t>(raw):-1-static_cast<std::int64_t>(~raw);
        return true;
    }
    bool Positive(){std::int64_t value;return Int64(value)&&value>0;}
    bool Time(std::int64_t& value){return Int64(value)&&value>=-62135596800000LL&&value<=253402300799999LL;}
    bool Boolean(bool& value){std::uint64_t raw;if(!Unsigned(1,raw)||raw>1)return false;value=raw==1;return true;}
    bool Text(std::string& value,bool reason=false)
    {
        std::int32_t count;if(!Int32(count)||count<0||count>(reason?8192:768)||static_cast<std::size_t>(count)>length-offset)return false;
        value.assign(reinterpret_cast<const char*>(data+offset),static_cast<std::size_t>(count));offset+=static_cast<std::size_t>(count);
        std::vector<std::uint32_t> codes;if(!DocumentExportWirePrimitives::Scalars(value,codes))return false;
        std::size_t units=0;bool nonWhitespace=false;
        for(auto code:codes)
        {
            if(code<32||(code>=127&&code<=159))return false;
            units+=code>65535?2:1;
            if(!DocumentExportWirePrimitives::Whitespace(code))nonWhitespace=true;
        }
        return units<=static_cast<std::size_t>(reason?2048:192)&&(reason||nonWhitespace);
    }
    bool Identifier(){std::string value;return Text(value);}
    bool Digest()
    {
        std::string value;return Text(value)&&value.size()==71&&value.substr(0,7)=="sha256:"&&DocumentExportWirePrimitives::Digest(value.substr(7));
    }
    bool Format(){std::string value;return Text(value)&&(value=="self-contained-html"||value=="pdf"||value=="docx"||value=="epub");}
    bool Status(){std::int32_t value;return Int32(value)&&value>=1&&value<=10;}
    bool Reason(){std::string value;return Text(value,true);}
    bool Source()
    {
        std::int32_t kind;bool draft,revision,publication;
        return Int32(kind)&&kind>=1&&kind<=3&&Positive()
            &&Boolean(draft)&&(!draft||Identifier())&&Boolean(revision)&&(!revision||Positive())
            &&Boolean(publication)&&(!publication||Positive())&&Positive()
            &&(kind==1?draft&&!revision&&!publication:kind==2?!draft&&revision&&!publication:!draft&&revision&&publication);
    }
    bool Output()
    {
        std::int64_t size,created,expires,deleted;bool hasDeleted;
        return Identifier()&&Identifier()&&Identifier()&&Digest()&&Digest()&&Int64(size)&&size>=0
            &&Time(created)&&Time(expires)&&expires>created&&Boolean(hasDeleted)&&(!hasDeleted||Time(deleted));
    }
    bool Job(std::string& task)
    {
        std::int64_t created,expires;std::int32_t count;bool output;
        if(!Text(task)||!Identifier()||!Source()||!Digest()||!Digest()||!Format()
            ||!Identifier()||!Identifier()||!Identifier()||!Identifier()||!Identifier()
            ||!Status()||!Positive()||!Time(created)||!Time(expires)||expires<=created||!Reason()||!Int32(count)||count<0||count>3)return false;
        for(std::int32_t i=0;i<count;i++)
        {
            std::int32_t number;bool diagnostic,hasFinished;std::int64_t started,finished;
            if(!Int32(number)||number!=i+1||!Boolean(diagnostic)||!Time(started)||!Boolean(hasFinished)
                ||(hasFinished&&(!Time(finished)||finished<started))||!Status()||!Reason())return false;
        }
        return Boolean(output)&&(!output||Output());
    }
    bool Page()
    {
        std::int32_t offsetValue,limit,count;bool more;
        if(!Int32(offsetValue)||offsetValue<0||!Int32(limit)||limit<1||limit>50||!Boolean(more)||!Int32(count)
            ||count<0||count>limit||(more&&count!=limit))return false;
        std::vector<std::string> tasks;
        for(std::int32_t i=0;i<count;i++)
        {
            std::string task;if(!Job(task))return false;
            for(const auto& previous:tasks)if(task==previous)return false;
            tasks.push_back(task);
        }
        return true;
    }
};
inline bool Validate(std::uint16_t frameType,const std::uint8_t* data,std::uint32_t length)
{
    const auto budget=PayloadBudget(frameType);
    if(!data||budget==0||length<4||length>budget)return false;
    Reader reader(data,length);std::int32_t revision;
    if(!reader.Int32(revision)||revision!=1)return false;
    bool valid=false;
    if(frameType==278)valid=reader.Identifier()&&reader.Identifier()&&reader.Source()&&reader.Format()&&reader.Identifier()&&reader.Identifier()&&reader.Identifier();
    else if(frameType==279)valid=reader.Identifier();
    else if(frameType==280){std::string task;valid=reader.Job(task);}
    else if(frameType==281)valid=reader.Page();
    return valid&&reader.Consumed();
}
}
