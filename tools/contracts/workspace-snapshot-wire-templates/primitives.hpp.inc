inline bool IsId(const std::string& value)
{
    if(value.size()<3 || value.size()>128) return false;
    auto alnum=[](unsigned char c){return (c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9');};
    if(!alnum(value[0])) return false;
    return std::all_of(value.begin(),value.end(),[&](unsigned char c){return alnum(c)||c=='.'||c=='_'||c==':'||c=='-';});
}
inline bool IsDigest(const std::string& value)
{
    return value.size()==64 && std::all_of(value.begin(),value.end(),[](unsigned char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
class Reader
{
    const std::uint8_t* bytes;
    std::size_t length;
    std::size_t offset=0;
public:
    Reader(const std::uint8_t* input,std::size_t count):bytes(input),length(count){}
    std::size_t Remaining() const {return length-offset;}
    bool Consumed() const {return offset==length;}
    bool Byte(std::uint8_t& value) {if(Remaining()<1)return false;value=bytes[offset++];return true;}
    bool Boolean(bool& value) {std::uint8_t raw;if(!Byte(raw)||raw>1)return false;value=raw==1;return true;}
    bool Int32(std::int32_t& value,std::int32_t min,std::int32_t max)
    {
        if(Remaining()<4)return false;
        std::uint32_t raw=0;for(int i=0;i<4;i++)raw|=std::uint32_t(bytes[offset++])<<(8*i);
        std::memcpy(&value,&raw,4);return value>=min&&value<=max;
    }
    bool Int64(std::int64_t& value,std::int64_t min,std::int64_t max)
    {
        if(Remaining()<8)return false;
        std::uint64_t raw=0;for(int i=0;i<8;i++)raw|=std::uint64_t(bytes[offset++])<<(8*i);
        std::memcpy(&value,&raw,8);return value>=min&&value<=max;
    }
    bool Closed(std::string& value,std::initializer_list<const char*> values)
    {
        std::uint8_t tag;if(!Byte(tag)||tag>=values.size())return false;
        value=*(values.begin()+tag);return true;
    }
    bool Text(std::string& value,std::size_t max,const std::string& kind)
    {
        std::int32_t count;if(!Int32(count,0,static_cast<std::int32_t>(max*4))||static_cast<std::size_t>(count)>Remaining())return false;
        value.assign(reinterpret_cast<const char*>(bytes+offset),count);offset+=count;
        std::size_t units=0;
        for(std::size_t i=0;i<value.size();)
        {
            auto first=static_cast<unsigned char>(value[i++]);std::uint32_t code;int more;
            if(first<0x80){code=first;more=0;}
            else if(first>=0xc2&&first<=0xdf){code=first&31;more=1;}
            else if(first>=0xe0&&first<=0xef){code=first&15;more=2;}
            else if(first>=0xf0&&first<=0xf4){code=first&7;more=3;}
            else return false;
            if(i+more>value.size())return false;
            for(int j=0;j<more;j++){auto c=static_cast<unsigned char>(value[i++]);if((c&0xc0)!=0x80)return false;code=(code<<6)|(c&63);}
            if((more==1&&code<0x80)||(more==2&&code<0x800)||(more==3&&code<0x10000)||code>0x10ffff||(code>=0xd800&&code<=0xdfff))return false;
            units+=code>0xffff?2:1;if(units>max)return false;
        }
        return (kind!="id"||IsId(value))&&(kind!="digest"||IsDigest(value));
    }
};
