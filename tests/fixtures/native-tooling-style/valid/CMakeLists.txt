cmake_minimum_required(VERSION 3.25)

function(AddFixtureTarget targetName)
    set(sourceFile NativeStyle.cpp)
    add_executable("${targetName}" "${sourceFile}")
endfunction()
