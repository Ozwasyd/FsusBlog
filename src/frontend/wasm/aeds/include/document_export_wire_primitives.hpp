#pragma once
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>
namespace FsusBlog::Aeds::DocumentExportWirePrimitives
{
inline bool Scalars(const std::string& value,std::vector<std::uint32_t>& result)
{
    result.clear();
    for(std::size_t i=0;i<value.size();)
    {
        auto first=static_cast<unsigned char>(value[i++]);std::uint32_t code;int more;
        if(first<128){code=first;more=0;}
        else if(first>=0xc2&&first<=0xdf){code=first&31;more=1;}
        else if(first>=0xe0&&first<=0xef){code=first&15;more=2;}
        else if(first>=0xf0&&first<=0xf4){code=first&7;more=3;}
        else return false;
        if(i+more>value.size())return false;
        for(int j=0;j<more;j++){auto byte=static_cast<unsigned char>(value[i++]);if((byte&0xc0)!=0x80)return false;code=(code<<6)|(byte&63);}
        if((more==1&&code<0x80)||(more==2&&code<0x800)||(more==3&&code<0x10000)||code>0x10ffff||(code>=0xd800&&code<=0xdfff))return false;
        result.push_back(code);
    }
    return true;
}
inline bool Whitespace(std::uint32_t code)
{
    return code==32||code==133||code==160||code==5760||(code>=8192&&code<=8202)||code==8232||code==8233||code==8239||code==8287||code==12288;
}
inline bool Digest(const std::string& value)
{
    return value.size()==64&&std::all_of(value.begin(),value.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
}
