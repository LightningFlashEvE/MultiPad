cmake_minimum_required(VERSION 3.16)
project(multipad_firmware_tests C)
enable_testing()

add_executable(pet_care_power_loss pet_care_power_loss.c ../USER/Lcd/pet_care.c)
target_compile_features(pet_care_power_loss PRIVATE c_std_11)
target_include_directories(pet_care_power_loss PRIVATE host ../USER/Lcd ../HARDWARE/FLASH)
add_test(NAME pet_care_power_loss COMMAND pet_care_power_loss)
