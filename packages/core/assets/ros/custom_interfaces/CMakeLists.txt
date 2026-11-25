cmake_minimum_required(VERSION 3.10)
project(custom_interfaces)
find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(unique_identifier_msgs REQUIRED)
rosidl_generate_interfaces(${PROJECT_NAME}
  "srv/Json.srv"
  "srv/Now.srv"
  "srv/Wait.srv"
  DEPENDENCIES unique_identifier_msgs
)
ament_export_dependencies(rosidl_default_runtime)
ament_package()
